(() => {
  // Example name in the name box: a random common British or US first name.
  const EXAMPLE_NAMES = ['Oliver', 'Amelia', 'Harry', 'Isla', 'George', 'Poppy', 'Alfie', 'Freya', 'Jack', 'Ella', 'Ethan', 'Madison', 'Tyler', 'Hannah', 'Logan', 'Avery', 'Mason', 'Chloe', 'Carter', 'Brooke'];
  document.getElementById('player-name').placeholder = `e.g. ${EXAMPLE_NAMES[Math.floor(Math.random() * EXAMPLE_NAMES.length)]}`;
  // Example room code under the code box, using the same letters real codes use.
  const EXAMPLE_CODE = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
  document.getElementById('room-code').placeholder = EXAMPLE_CODE;
  document.querySelectorAll('[data-example-code]').forEach(el => { el.textContent = EXAMPLE_CODE; });
  const $ = (selector, root = document) => root.querySelector(selector);
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  const landing = $('#landing'), game = $('#game'), toastEl = $('#toast'), announcer = $('#announcer');
  const TEAM_NAME = { red: 'Red Plate', black: 'Black Plate' };

  let socket = null, state = null, selfId = null, clockOffset = 0;
  let view = null, tickFn = null, pullView = null;
  let retries = 0, retryTimer = null, leaving = false, silentJoin = false;

  const read = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  let saved = read('pressroom-player') || {};

  const now = () => Date.now() + clockOffset;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const fmt = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const pct = position => ((position + state.edge) / (state.edge * 2)) * 100;
  const me = () => state?.players.find(p => p.id === selfId);
  const isHost = () => state?.hostId === selfId;
  const hostName = () => state?.players.find(p => p.id === state.hostId)?.name || 'the Foreman';
  const teamOf = team => state.players.filter(p => p.team === team);
  const buzz = pattern => { try { navigator.vibrate?.(pattern); } catch {} };

  // ---------- Sound: every effect is synthesised, so there are no audio files to load ----------
  const sound = (() => {
    const button = $('#sound-toggle');
    let ctx = null, on = read('pressroom-sound') !== false;
    const paint = () => { button.setAttribute('aria-pressed', on); button.setAttribute('aria-label', on ? 'Sound on' : 'Sound off'); button.classList.toggle('muted', !on); };
    const unlock = () => {
      if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ctx = new AC(); }
      if (ctx?.state === 'suspended') ctx.resume();
    };
    const envelope = (node, t, peak, dur) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      node.connect(g); g.connect(ctx.destination);
    };
    const osc = (type, from, to, t, dur, peak) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(from, t);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
      envelope(o, t, peak, dur); o.start(t); o.stop(t + dur + 0.02);
    };
    const noise = (t, dur, peak, cutoff) => {
      const length = Math.floor(ctx.sampleRate * dur), buffer = ctx.createBuffer(1, length, ctx.sampleRate), data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource(), filter = ctx.createBiquadFilter();
      src.buffer = buffer; filter.type = 'lowpass'; filter.frequency.value = cutoff; src.connect(filter);
      envelope(filter, t, peak, dur); src.start(t);
    };
    const effects = {
      stamp: t => { noise(t, 0.07, 0.45, 1400); osc('sine', 150, 55, t, 0.14, 0.6); },
      heavy: t => { effects.stamp(t); effects.stamp(t + 0.09); },
      thud: t => { noise(t, 0.05, 0.12, 700); osc('sine', 110, 60, t, 0.08, 0.15); },
      reject: t => { osc('square', 190, 0, t, 0.07, 0.07); osc('square', 140, 0, t + 0.09, 0.1, 0.07); },
      strike: t => { noise(t, 0.2, 0.3, 3200); osc('sawtooth', 320, 90, t, 0.2, 0.07); },
      tick: t => osc('square', 1500, 0, t, 0.025, 0.035),
      bell: t => [880, 1320, 1760].forEach((f, i) => osc('sine', f, 0, t + i * 0.004, 1.2 - i * 0.3, 0.16 / (i + 1))),
      win: t => { [0, 0.15, 0.3].forEach(d => effects.stamp(t + d)); effects.bell(t + 0.5); },
      badge: t => { effects.stamp(t); [1047, 1568].forEach((f, i) => osc('sine', f, 0, t + 0.12 + i * 0.1, 0.6, 0.08)); },
      levelup: t => { [0, 0.12, 0.24, 0.36].forEach(d => effects.stamp(t + d)); effects.bell(t + 0.5); },
      combo: t => osc('triangle', 660, 1320, t, 0.12, 0.08),
    };
    paint();
    button.addEventListener('click', () => { on = !on; write('pressroom-sound', on); paint(); if (on) play('stamp'); });
    addEventListener('pointerdown', unlock, { once: true });
    addEventListener('keydown', unlock, { once: true });
    function play(name) { if (!on) return; unlock(); if (!ctx) return; try { effects[name](ctx.currentTime + 0.01); } catch {} }
    return { play };
  })();

  // ---------- Printer's rank, badges and combos (fx.js) ----------
  const icon = d => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  FX.setup({
    key: 'pressroom', sound: name => sound.play(name), cardTitle: "PRINTER'S RANK", levelKicker: 'HOT OFF THE PRESS', badgeKicker: 'ENGRAVED MEDAL', badgeShelf: 'MEDALS',
    ranks: ["Printer's Devil", 'Inker', 'Compositor', 'Typesetter', 'Pressman', 'Journeyman Printer', 'Foreman', 'Master Printer', 'Proprietor'],
    statLabels: { games: 'Matches', wins: 'Wins', words: 'Words set', sets: 'Sets won' },
    particles: ['<i class="pt-ink"></i>', '<i class="pt-ink red"></i>', '<i class="pt-sort">A</i>', '<i class="pt-sort red">Q</i>', '<i class="pt-sort">R</i>'],
    badges: {
      'first-word': { name: 'First Impression', desc: 'Set your first word in type.', icon: icon('M4 4h16v4h-6v12h-4V8H4z'), xp: 20 },
      'long-word': { name: 'Long Primer', desc: 'Set a word of 10 letters or more.', icon: icon('M2 10h20v4H2zM2 5h12v3H2zm0 11h16v3H2z'), xp: 40 },
      'hot-hand': { name: 'Hot Hand', desc: 'Set three hot-letter words in one set.', icon: icon('M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-7 0 3 1 4 3 4-1-3-1-6 0-9z'), xp: 40 },
      combo: { name: 'Running Press', desc: 'Land a five-word combo.', icon: icon('M13 1L4 14h7l-1 9 9-13h-7z'), xp: 50 },
      'set-win': { name: 'Stop the Presses', desc: 'Win a set with your plate.', icon: icon('M12 2l3 7h7l-5.5 4.5 2 7.5-6.5-4.5L5.5 21l2-7.5L2 9h7z'), xp: 30 },
      'match-win': { name: 'Front Page', desc: 'Win a whole match.', icon: icon('M3 4h18v16H3zm2 2v4h14V6zm0 6v6h6v-6zm8 0v2h6v-2zm0 4v2h6v-2z'), xp: 80 },
      mvp: { name: 'Printer of the Set', desc: 'Pull the most for anyone in a set.', icon: icon('M2 7l5 4 5-7 5 7 5-4-2 12H4z'), xp: 50 },
      veteran: { name: 'Ink in the Veins', desc: 'Finish five matches.', icon: icon('M12 2c3 5 7 9 7 13a7 7 0 0 1-14 0c0-4 4-8 7-13z'), xp: 80 },
    },
  });
  FX.card(document.getElementById('press-card'));
  let combo = 0, lastSet = 0, hotThisSet = 0, comboTimer = null;
  const processed = new Set();
  // Words landed within four seconds of each other build a combo (typing-game style); it's display only.
  function bumpCombo(msg) {
    clearTimeout(comboTimer);
    combo++;
    comboTimer = setTimeout(() => { combo = 0; paintCombo(); }, 4000);
    paintCombo();
    const composer = $('#composer');
    FX.float(composer, `+${msg.pull}${combo >= 3 ? ` · COMBO ×${combo}` : ''}`, combo >= 3 ? 'fx-combo' : '');
    if (combo >= 3) sound.play('combo');
    if (combo >= 5) { FX.unlock('combo'); FX.burst(composer, { count: 14 }); }
  }
  function paintCombo() { const el = $('#combo-meter'); if (el) { el.className = `streak combo ${combo >= 5 ? 'hot' : ''} ${combo >= 2 ? '' : 'idle'}`; el.innerHTML = `COMBO <b>×${combo}</b>`; } }
  function processSet() {
    const s = state, set = s.sets.at(-1), mine = me()?.team, key = `${s.code}:${s.sets.length}:${set?.seconds}`;
    if (!set || processed.has(key)) return;
    processed.add(key);
    let xp = 10;
    if (set.winner && set.winner === mine) { xp += 30; FX.bump('sets'); FX.unlock('set-win'); }
    if (set.mvp && set.mvp.name === me()?.name) FX.unlock('mvp');
    if (s.matchOver) {
      const matchWinner = s.score.red > s.score.black ? 'red' : s.score.black > s.score.red ? 'black' : null;
      const won = !!mine && matchWinner === mine;
      FX.recordGame(won); xp += 20 + (won ? 80 : 0);
      if (won) FX.unlock('match-win');
      if (FX.profile().games >= 5) FX.unlock('veteran');
    }
    setTimeout(() => FX.addXP(xp, $('.gz-headline')), 900);
  }
  function shareText() {
    const s = state, mine = me()?.team, p = me();
    return `Pressroom Pull · shop ${s.code}\n${s.sets.map(x => (x.winner === 'red' ? '🟥' : x.winner === 'black' ? '⬛' : '⬜')).join(' ')}  Red ${s.score.red}–${s.score.black} Black\n${p ? `${p.name} (${TEAM_NAME[mine] || 'watching'}): ${p.words} words, ${p.pull} pull` : ''}\nPrinter's rank: ${FX.level().name}`;
  }

  function toast(message) {
    toastEl.textContent = message; toastEl.classList.add('show');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => toastEl.classList.remove('show'), 2400);
  }
  function announce(message) { announcer.textContent = ''; setTimeout(() => { announcer.textContent = message; }, 60); }
  setInterval(() => tickFn?.(), 200);

  // ---------- Landing ----------
  const params = new URLSearchParams(location.search);
  const linkCode = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  const nameInput = $('#player-name'), codeInput = $('#room-code'), landingError = $('#landing-error');
  nameInput.value = saved.name || '';
  codeInput.value = linkCode;
  $('#slip-no').textContent = String(1000 + Math.floor(Math.random() * 9000));
  if (linkCode) landing.classList.add('invited');

  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); });
  $('#landing-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = checkName(); if (!name) return;
    const code = codeInput.value;
    if (code.length !== 4) { landingError.textContent = 'Enter the four-letter shop code.'; codeInput.focus(); return; }
    connect({ type: 'join', name, code, token: saved.code === code ? saved.token : undefined });
  });
  $('#host-button').addEventListener('click', () => { const name = checkName(); if (name) connect({ type: 'create', name }); });
  $('#practice-button').addEventListener('click', () => { const name = checkName(); if (name) connect({ type: 'practice', name }); });
  function checkName() {
    const name = nameInput.value.trim();
    if (name.length >= 2 && name.length <= 14) return name;
    landingError.textContent = 'Choose a name between 2 and 14 characters.'; nameInput.focus(); return null;
  }
  function setBusy(busy) { landing.querySelectorAll('button').forEach(b => { b.disabled = busy; }); }

  const howto = $('#howto');
  $('#help-open').addEventListener('click', () => howto.showModal());
  $('#help-close').addEventListener('click', () => howto.close());
  $('#got-it').addEventListener('click', () => howto.close());
  if (!read('pressroom-howto')) { setTimeout(() => { if (!howto.open) howto.showModal(); }, 600); write('pressroom-howto', true); }

  // ---------- Connection ----------
  function connect(hello) {
    landingError.textContent = ''; leaving = false; clearTimeout(retryTimer);
    if (socket) { socket.onclose = null; socket.close(); }
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`);
    socket = ws; if (!state) setBusy(true);
    ws.onopen = () => { retries = 0; document.body.classList.remove('offline'); ws.send(JSON.stringify(hello)); };
    ws.onmessage = event => onMessage(JSON.parse(event.data));
    ws.onclose = () => {
      if (ws !== socket) return;
      setBusy(false);
      if (leaving || !state) { if (!state && !leaving) landingError.textContent = 'Could not reach the pressroom. Try again.'; return; }
      document.body.classList.add('offline');
      retryTimer = setTimeout(() => connect({ type: 'join', code: state.code, token: saved.token }), Math.min(8000, 600 * 2 ** retries++));
    };
  }
  const send = (type, data = {}) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...data })); };

  function onMessage(msg) {
    if (msg.type === 'state') {
      const previous = state;
      state = msg.state; selfId = msg.selfId; clockOffset = state.serverNow - Date.now();
      saved = { name: me()?.name || saved.name, code: state.code, token: msg.token }; write('pressroom-player', saved);
      if (!previous) history.replaceState(null, '', `/?room=${state.code}`);
      silentJoin = false; setBusy(false); render(previous); return;
    }
    if (msg.type === 'accepted') return onAccepted(msg);
    if (msg.type === 'reject') return onRejected(msg.message);
    if (msg.type === 'error') {
      if (msg.code === 'no-room') {
        const hadShop = !!state; forget(); showLanding();
        if (hadShop) landingError.textContent = 'That shop has closed. Open a new one.';
        else if (!silentJoin) landingError.textContent = 'Shop code not found. Check it with your Foreman.';
        silentJoin = false;
        return;
      }
      if (state) toast(msg.message); else { landingError.textContent = msg.message; setBusy(false); }
    }
  }
  function forget() { saved = { name: saved.name }; write('pressroom-player', saved); history.replaceState(null, '', '/'); }
  function showLanding() {
    state = null; view = null; tickFn = null; pullView = null;
    game.classList.add('hidden'); game.innerHTML = ''; landing.classList.remove('hidden', 'invited');
    FX.card($('#press-card'));
    document.body.classList.remove('offline'); setBusy(false);
  }

  // ---------- Rendering ----------
  function render(previous) {
    landing.classList.add('hidden'); game.classList.remove('hidden');
    const live = state.phase === 'pull' || state.phase === 'sudden';
    const key = live ? `pull:${state.setNumber}` : `${state.phase}:${state.setNumber}`;
    const fresh = key !== view;
    view = key;
    if (fresh) { tickFn = null; window.scrollTo({ top: 0 }); }
    if (state.phase === 'lobby') renderLobby();
    else if (state.phase === 'preview') { if (fresh) renderPreview(); }
    else if (live) renderPull(fresh, previous);
    else renderResult(fresh);
  }

  function shopHead() {
    return `<div class="shophead">
      <button class="shop-code" data-action="invite" aria-label="Shop code ${state.code}. Copy invite link" title="Copy invite link">${[...state.code].map(c => `<span class="wood">${c}</span>`).join('')}</button>
      <div class="shop-meta"><span class="kicker">SHOP CODE</span><button class="link-button" data-action="invite">Copy invite link</button></div>
      <div class="shop-right">${isHost() ? '<span class="foreman-tag">✦ You are the Foreman</span>' : `<span class="kicker">FOREMAN · ${esc(hostName())}</span>`}<button class="link-button" data-action="leave">Leave shop</button></div>
    </div>${coachBar()}`;
  }
  function coachBar() {
    const c = coach(); if (!c) return '';
    return `<div class="coach" role="note"><span class="coach-tag">YOUR MOVE</span><div class="coach-text"><b>${c[0]}</b>${c[1] ? `<span>${c[1]}</span>` : ''}</div></div>`;
  }
  // One plain instruction for what to do right now.
  function coach() {
    const p = state.phase, mine = me()?.team, host = isHost();
    if (p === 'lobby') return host ? ['Pick a team (plate), then press START THE PRESS RUN.', 'Each plate needs at least one printer. Playing alone? Tap + Add a bot printer.'] : ['Pick a team (plate) and wait for the Foreman to start.', 'Red pulls left, Black pulls right.'];
    if (p === 'preview') return ['Get ready to type words that fit the category.', 'Every word drags the brass slug toward your side and uses metal letters from your plate\u2019s type case. Longer words pull harder; the hot letter doubles the pull, but there are only a few of it.'];
    if (p === 'pull' || p === 'sudden') return mine ? [`Type words that fit \u201c${esc(state.category)}\u201d and press Enter.`, `Drag the slug to the ${mine === 'red' ? 'LEFT (red)' : 'RIGHT (black)'} edge. Every word uses letters from your plate\u2019s type case (below the input); they come back 10 seconds later. Short on E? Spend your rare sorts.`] : ['You\u2019re watching this set.', 'You join a plate at the next set.'];
    if (p === 'result') return state.matchOver ? ['Match over.', host ? 'Press Rematch to play again with the same teams.' : 'Share your result, or wait for a rematch.'] : ['Set done. First to win 2 sets wins the match.', host ? 'Press Next category when everyone is ready.' : 'Wait for the Foreman to roll the next category.'];
    return null;
  }

  // Lobby
  function renderLobby() {
    const red = teamOf('red'), black = teamOf('black'), mine = me()?.team, ready = red.length && black.length;
    game.innerHTML = `${shopHead()}
    <div class="lobby">
      <div class="section-title"><span class="kicker">THE COMPOSING ROOM</span><h2>Choose your plate</h2><p>${state.players.length} of 12 printers in the shop. Tap a plate to stand with it.</p></div>
      <div class="cases">${caseCard('red', red, mine)}${caseCard('black', black, mine)}</div>
      ${Math.abs(red.length - black.length) >= 2 ? '<p class="notice">Uneven plates. The smaller plate will pull +1 on every word.</p>' : ''}
      <div class="invite-strip"><span class="kicker">CALL IN THE CREW</span><code>${esc(location.host)}/?room=${state.code}</code><button class="button ghost small" data-action="invite">Copy link</button></div>
      <div class="lobby-foot">${isHost()
        ? `<button class="button red big" data-action="start" ${ready ? '' : 'disabled'}>Start the press run <span aria-hidden="true">→</span></button><p class="hint">${ready ? 'Best of three sets · 75 seconds each' : 'Both plates need at least one printer.'}</p>`
        : `<p class="waiting">Waiting for ${esc(hostName())} to start the press<span class="dots" aria-hidden="true"></span></p>`}</div>
    </div>`;
  }
  function caseCard(team, players, mine) {
    return `<article class="case ${team}">
      <header class="case-head"><span class="swatch ${team}" aria-hidden="true"></span><div><h3>${TEAM_NAME[team].toUpperCase()}</h3><span class="kicker">${team === 'red' ? 'SOLID INK' : 'CROSS-HATCHED'} · ${players.length} ${players.length === 1 ? 'PRINTER' : 'PRINTERS'}</span></div><span class="case-arrow" aria-hidden="true">${team === 'red' ? '←' : '→'}</span></header>
      <ul class="slugs">${players.map(p => `<li class="${p.id === selfId ? 'self' : ''}">${esc(p.name)}${p.id === state.hostId ? '<i title="Foreman">✦</i>' : ''}${p.id === selfId ? '<small>YOU</small>' : ''}${p.isBot ? `<small class="bot">BOT</small>${isHost() ? `<button class="bot-x" data-action="removeBot" data-id="${p.id}" aria-label="Remove ${esc(p.name)}">×</button>` : ''}` : ''}</li>`).join('') || '<li class="empty">Empty case. Waiting for a printer…</li>'}</ul>
      <button class="button ${team === 'red' ? 'red' : 'ink'} full" data-action="switch" data-team="${team}" ${mine === team ? 'disabled' : ''}>${mine === team ? 'Your plate' : `Stand with ${team}`}</button>
      ${isHost() && state.players.length < 12 ? `<button class="link-button add-bot" data-action="addBot" data-team="${team}">+ Add a bot printer</button>` : ''}
    </article>`;
  }

  // Category preview
  function renderPreview() {
    const mine = me()?.team;
    game.innerHTML = `${shopHead()}
    <div class="call-card">
      <span class="kicker">SET ${state.setNumber} OF ${state.maxSets} · THE FOREMAN CALLS</span>
      <h2 class="category-call" aria-label="${esc(state.category)}">${letterpress(state.category)}</h2>
      <div class="hot-block"><span class="wood big">${state.hotLetter}</span><div><span class="kicker">HOT LETTER</span><b>Words with ${state.hotLetter} pull double</b></div></div>
      <div class="countdown" id="countdown-ring"><span id="countdown">5</span></div>
      <p class="side-note">${mine ? `You pull for the <b class="${mine}">${mine === 'red' ? '← Red Plate' : 'Black Plate →'}</b>` : 'You are watching this set. You will join a plate at the next one.'}</p>
      <ul class="tiers" aria-label="Pull values"><li><b>+1</b>3–4 letters</li><li><b>+2</b>5–7 letters</li><li><b>+3</b>8+ letters</li><li><b>×2</b>hot letter</li></ul>
      ${mine ? `<p class="case-note"><b>Mind your type case.</b> Your plate shares a tray of metal letters: every word you set uses them up, and they’re put back 10 seconds later. Only ${state.cases?.[mine]?.[state.hotLetter.toLowerCase()] ?? 2} ${state.hotLetter}s this set.</p>` : ''}
    </div>`;
    announce(`Set ${state.setNumber}. The category is ${state.category}. Hot letter ${state.hotLetter}.`);
    sound.play('thud');
    let last = null;
    tickFn = () => {
      const left = Math.max(0, Math.ceil((state.previewEndsAt - now()) / 1000));
      if (left === last) return; last = left;
      const ring = $('#countdown-ring'); if (!ring) return;
      $('#countdown').textContent = left || 'GO';
      ring.classList.remove('beat'); void ring.offsetWidth; ring.classList.add('beat');
      if (left > 0 && left <= 3) sound.play('tick');
    };
    tickFn();
  }

  // Each word stays on one line while its letters drop in one by one.
  function letterpress(text) {
    let i = 0;
    return text.split(' ').map(word => `<span class="call-word">${[...word].map(c => `<span style="animation-delay:${i++ * 32}ms">${esc(c)}</span>`).join('')}</span>`).join(' ');
  }

  // Pull screen: built once per set, then patched so the input, scroll and slug animation survive every update.
  function renderPull(fresh) {
    if (fresh || pullView?.host !== isHost()) buildPull();
    updatePull();
  }
  function buildPull() {
    const mine = me()?.team, keep = $('#word-input')?.value || '';
    game.innerHTML = `${shopHead()}
    <div class="press">
      <div class="scoreboard">
        <div class="sb-team red"><span class="swatch red" aria-hidden="true"></span><div><b>RED<span class="long"> PLATE</span></b><span class="sb-meta" id="sb-red"></span></div><span class="marks" id="marks-red"></span></div>
        <div class="sb-clock"><span class="kicker" id="set-label"></span><span class="clock" id="clock" role="timer">1:15</span></div>
        <div class="sb-team black"><span class="marks" id="marks-black"></span><div><b>BLACK<span class="long"> PLATE</span></b><span class="sb-meta" id="sb-black"></span></div><span class="swatch black" aria-hidden="true"></span></div>
      </div>
      <div class="callout">
        <div><span class="kicker">THE FOREMAN CALLS</span><h2>${esc(state.category)}</h2></div>
        <div class="hot-block compact" title="Words containing ${state.hotLetter} pull double"><span class="wood">${state.hotLetter}</span><div><span class="kicker">HOT LETTER</span><b>×2 pull</b></div></div>
      </div>
      <div class="banner" id="banner" hidden></div>
      <div class="rule-wrap">
        <div class="rule" id="rule" role="img" aria-label="Slug position">
          <div class="edge red"></div><div class="edge black"></div>
          <div class="fill" id="fill"></div><div class="center-line"></div>
          <div class="slug" id="slug"><span class="slug-arrow"></span></div>
          <div class="pops" id="pops" aria-hidden="true"></div>
        </div>
        <div class="rule-scale" aria-hidden="true">${[12, 9, 6, 3, 0, 3, 6, 9, 12].map((n, i) => `<span style="left:${i * 12.5}%">${n}</span>`).join('')}</div>
        <div class="rule-ends"><span class="red">← RED EDGE</span><b id="lead-text">DEAD EVEN</b><span>BLACK EDGE →</span></div>
      </div>
      <div class="galleys">${galley('red', mine)}${galley('black', mine)}</div>
      ${mine ? `<form class="composer ${mine}" id="composer" autocomplete="off">
        <div class="composer-field"><input id="word-input" maxlength="20" placeholder="Set your type…" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="send" aria-label="Type a word" aria-describedby="composer-note"><span class="estimate" id="estimate" aria-hidden="true"></span></div>
        <button class="button ${mine === 'red' ? 'red' : 'ink'}" type="submit">SET <span aria-hidden="true">↵</span></button>
        <div class="type-case" id="type-case" aria-label="Your plate's type case"></div>
        <p class="composer-note" id="composer-note" aria-live="assertive">You pull for the ${mine === 'red' ? '← Red Plate' : 'Black Plate →'}. Enter to set.</p>
        <span id="combo-meter" class="streak combo idle" aria-hidden="true">COMBO <b>×0</b></span>
      </form>` : '<p class="spectating">You are watching this set. You will join a plate at the next one.</p>'}
    </div>`;
    pullView = { seen: new Map(), lastPosition: state.position, lastAnnounce: now(), lastSecond: null, host: isHost(), ready: false };
    const input = $('#word-input');
    if (input) {
      input.value = keep;
      $('#composer').addEventListener('submit', event => {
        event.preventDefault();
        const word = input.value.trim(); if (!word) return;
        send('word', { word }); input.value = ''; showEstimate(); paintCase();
      });
      input.addEventListener('input', () => { showEstimate(); paintCase(); });
      input.focus({ preventScroll: true });
    }
    tickFn = pullTick;
  }
  function galley(team, mine) {
    return `<section class="galley ${team} ${mine === team ? 'mine' : ''}" aria-label="${TEAM_NAME[team]} words">
      <header><span class="swatch ${team}" aria-hidden="true"></span><b>${TEAM_NAME[team].toUpperCase()}</b>${mine === team ? '<small>YOUR PLATE</small>' : ''}<span class="count" id="count-${team}">0 words</span></header>
      <ol class="galley-list" id="list-${team}"><li class="empty">No type set yet.</li></ol>
    </section>`;
  }
  function showEstimate() {
    const input = $('#word-input'), el = $('#estimate'); if (!input || !el) return;
    const word = input.value.trim().toLowerCase().replace(/[^a-z]/g, '');
    el.className = 'estimate';
    if (word.length < 3) { el.textContent = ''; return; }
    if (state.feed.some(x => x.word === word)) { el.textContent = 'USED'; el.classList.add('show', 'used'); return; }
    const short = shortSorts(word);
    if (short.length) { el.textContent = `NO ${short.join('').toUpperCase()}`; el.classList.add('show', 'used'); return; }
    const hot = word.includes(state.hotLetter.toLowerCase()), tier = word.length <= 4 ? 1 : word.length <= 7 ? 2 : 3;
    el.textContent = `+${Math.min(6, tier * (hot ? 2 : 1))}${hot ? ' ✦' : ''}`;
    el.classList.add('show'); if (hot) el.classList.add('hot');
  }
  // The type case: counts of each sort left on my plate, the letters the current word needs, and what is coming back.
  function shortSorts(word) {
    const box = state.cases?.[me()?.team]; if (!box) return [];
    const need = {}; for (const c of word) need[c] = (need[c] || 0) + 1;
    return Object.keys(need).filter(c => (box[c] || 0) < need[c]);
  }
  function paintCase() {
    const el = $('#type-case'), team = me()?.team, box = state.cases?.[team]; if (!el || !box) return;
    const word = ($('#word-input')?.value || '').toLowerCase().replace(/[^a-z]/g, ''), need = {};
    for (const c of word) need[c] = (need[c] || 0) + 1;
    const back = {}; let next = null;
    for (const r of state.returning || []) if (r.team === team) { for (const c of r.letters) back[c] = (back[c] || 0) + 1; next = next == null ? r.at : Math.min(next, r.at); }
    const hot = state.hotLetter.toLowerCase();
    const html = `<div class="case-grid">${'abcdefghijklmnopqrstuvwxyz'.split('').map(c => {
      const n = box[c] || 0, cls = [n === 0 ? 'out' : n === 1 ? 'low' : '', need[c] ? (need[c] > n ? 'short' : 'need') : '', c === hot ? 'hot' : ''].join(' ');
      return `<span class="sort ${cls}" title="${c.toUpperCase()}: ${n} left${back[c] ? `, ${back[c]} coming back` : ''}"><b>${c.toUpperCase()}</b><i>${n}</i>${back[c] ? `<small>+${back[c]}</small>` : ''}</span>`;
    }).join('')}</div><span class="case-meta">TYPE CASE${next ? ` · type back in ${Math.max(0, Math.ceil((next - now()) / 1000))}s` : ' · all type in the case'}</span>`;
    if (el.__html !== html) { el.innerHTML = html; el.__html = html; }
  }
  function markHot(word) {
    const letter = state.hotLetter.toLowerCase();
    return [...word].map(c => c === letter ? `<mark>${esc(c.toUpperCase())}</mark>` : esc(c.toUpperCase())).join('');
  }
  function rowMarkup(item) {
    return `<span class="word">${item.hot ? markHot(item.word) : esc(item.word.toUpperCase())}</span>
      <span class="by">${esc(item.name)}${item.bonus ? ' · +1 bonus' : ''}</span>
      <span class="pts">${item.struck ? '−' : '+'}${item.pull}</span>
      ${pullView.host && !item.struck ? `<button class="strike-btn" type="button" data-action="strike" data-id="${item.id}" aria-label="Strike ${esc(item.word)}">STRIKE</button>` : ''}`;
  }
  function updatePull() {
    const s = state, position = s.position, lead = position < 0 ? 'red' : position > 0 ? 'black' : null;
    const slug = $('#slug'), fill = $('#fill'), rule = $('#rule');
    slug.style.left = `${pct(position)}%`;
    slug.className = `slug ${lead ? `lead-${lead}` : 'even'}`;
    fill.className = `fill ${lead || ''}`;
    fill.style.left = `${Math.min(50, pct(position))}%`;
    fill.style.width = `${Math.abs(pct(position) - 50)}%`;
    rule.classList.toggle('danger-red', position <= -(s.edge - 3));
    rule.classList.toggle('danger-black', position >= s.edge - 3);
    rule.setAttribute('aria-label', lead ? `Slug ${Math.abs(position)} toward the ${TEAM_NAME[lead]}` : 'Slug at the centre');
    $('#lead-text').textContent = lead ? `${lead.toUpperCase()} LEADS BY ${Math.abs(position)} · ${s.edge - Math.abs(position)} TO THE EDGE` : 'DEAD EVEN';
    if (Math.abs(position - pullView.lastPosition) >= 4 && pullView.ready) { slug.classList.add('jolt'); setTimeout(() => slug.classList.remove('jolt'), 380); }

    // Scoreboard
    for (const team of ['red', 'black']) {
      const kept = s.feed.filter(x => x.team === team && !x.struck);
      const tally = s.tally?.[team] || { words: kept.length, pull: kept.reduce((n, x) => n + x.pull, 0) };
      $(`#sb-${team}`).textContent = `${tally.words} ${tally.words === 1 ? 'word' : 'words'} · ${tally.pull} pull`;
      $(`#count-${team}`).textContent = `${tally.words} ${tally.words === 1 ? 'word' : 'words'}`;
      $(`#marks-${team}`).innerHTML = Array.from({ length: 2 }, (_, i) => `<i class="${i < s.score[team] ? 'won' : ''}"></i>`).join('');
    }
    $('#set-label').textContent = s.phase === 'sudden' ? 'SUDDEN DEATH' : `SET ${s.setNumber} OF ${s.maxSets}`;
    paintBanner();

    // Word feeds: append new type, update struck type, never rebuild.
    for (const item of s.feed) {
      const known = pullView.seen.get(item.id);
      if (!known) {
        const list = $(`#list-${item.team}`); list.querySelector('.empty')?.remove();
        const li = document.createElement('li');
        li.className = `type-row ${item.hot ? 'hot' : ''} ${item.struck ? 'struck' : ''} ${pullView.ready ? 'fresh' : ''}`;
        li.innerHTML = rowMarkup(item); list.prepend(li);
        pullView.seen.set(item.id, { li, struck: item.struck });
        if (pullView.ready) {
          pop(`+${item.pull}`, item.team, item.hot);
          if (item.playerId !== selfId) sound.play('thud');
        }
      } else if (item.struck && !known.struck) {
        known.struck = true; known.li.classList.add('struck'); known.li.innerHTML = rowMarkup(item);
        pop(`STRUCK`, item.team, false, true); sound.play('strike');
        if (item.playerId === selfId) toast(`The Foreman struck ${item.word.toUpperCase()}.`);
      }
    }
    pullView.lastPosition = position; pullView.ready = true;
    paintCase(); showEstimate();
    pullTick();
  }
  function paintBanner() {
    const banner = $('#banner'), s = state;
    let text = '', kind = '';
    if (s.pause) { kind = 'pause'; text = `The ${TEAM_NAME[s.pause.team]} has left the press · forfeit in ${Math.max(0, Math.ceil((s.pause.until - now()) / 1000))}s`; }
    else if (s.phase === 'sudden') { kind = 'sudden'; text = 'Sudden death · the next word wins the set'; }
    else if (s.balanced) { kind = 'note'; text = 'Uneven plates · the smaller plate pulls +1 per word'; }
    banner.hidden = !text; banner.className = `banner ${kind}`; banner.textContent = text;
  }
  function pop(text, team, hot, struck) {
    const layer = $('#pops'); if (!layer) return;
    const el = document.createElement('span');
    el.className = `pop ${team} ${hot ? 'hot' : ''} ${struck ? 'struck' : ''}`; el.textContent = text;
    el.style.left = `${pct(state.position)}%`;
    layer.append(el); setTimeout(() => el.remove(), 1000);
  }
  function pullTick() {
    const s = state; if (!s || !pullView) return;
    const end = s.phase === 'sudden' ? s.suddenEndsAt : s.endsAt;
    const left = Math.max(0, Math.ceil((end - (s.pause ? s.pause.startedAt : now())) / 1000));
    const clock = $('#clock'); if (!clock) return;
    clock.textContent = s.pause ? 'PAUSED' : fmt(left);
    paintCase();
    clock.classList.toggle('urgent', !s.pause && left <= 10);
    if (left !== pullView.lastSecond) {
      if (!s.pause && left <= 5 && left > 0 && pullView.lastSecond !== null) sound.play('tick');
      pullView.lastSecond = left;
      if (s.pause) paintBanner();
    }
    if (now() - pullView.lastAnnounce >= 5000) {
      pullView.lastAnnounce = now();
      const lead = s.position < 0 ? 'red' : s.position > 0 ? 'black' : null;
      announce(`${lead ? `Slug ${Math.abs(s.position)} toward the ${TEAM_NAME[lead]}` : 'Slug at the centre'}. ${left} seconds left.`);
    }
  }
  function onAccepted(msg) {
    sound.play(msg.pull >= 4 ? 'heavy' : 'stamp'); buzz(12);
    if (state?.setNumber !== lastSet) { lastSet = state.setNumber; hotThisSet = 0; }
    FX.bump('words'); FX.unlock('first-word');
    if (msg.word.length >= 10) FX.unlock('long-word');
    if (msg.hot && ++hotThisSet >= 3) FX.unlock('hot-hand');
    FX.addXP(msg.pull * 2);
    bumpCombo(msg);
    const note = $('#composer-note'), composer = $('#composer');
    if (note) { note.className = 'composer-note ok'; note.textContent = `✓ ${msg.word.toUpperCase()} set in type · +${msg.pull}${msg.hot ? ' · hot letter ×2' : ''}${msg.bonus ? ' · +1 small plate' : ''}`; }
    if (composer) { composer.classList.remove('stamped'); void composer.offsetWidth; composer.classList.add('stamped'); }
    if (document.activeElement === document.body) $('#word-input')?.focus({ preventScroll: true });
  }
  function onRejected(message) {
    sound.play('reject'); buzz([25, 40, 25]);
    const note = $('#composer-note'), composer = $('#composer');
    if (!note) return toast(message);
    note.className = 'composer-note bad'; note.textContent = `✗ ${message}`;
    composer.classList.remove('shake'); void composer.offsetWidth; composer.classList.add('shake');
  }

  // Set and match results
  function renderResult(fresh) {
    const s = state, set = s.sets.at(-1); if (!set) return;
    const over = s.matchOver, winner = set.winner, mine = me()?.team;
    const matchWinner = s.score.red > s.score.black ? 'red' : s.score.black > s.score.red ? 'black' : null;
    const headline = over
      ? (matchWinner ? `${matchWinner.toUpperCase()} PLATE WINS THE MATCH` : 'THE MATCH ENDS ALL SQUARE')
      : (winner ? `${winner.toUpperCase()} PLATE TAKES SET ${set.number}` : `DEAD HEAT IN SET ${set.number}`);
    const how = { edge: `Pulled to the edge in ${fmt(set.seconds)}.`, time: 'Ahead when the bell rang.', sudden: 'Won with the first word of sudden death.', forfeit: 'The other plate left the press.', tie: 'Nobody moved the slug in sudden death.' }[set.reason] || '';
    const deck = over ? `${winner ? `${TEAM_NAME[winner]} took the final set. ` : ''}Final score ${s.score.red}–${s.score.black}.` : `${how} The category was “${esc(set.category)}”.`;
    const star = over ? [...s.players].sort((a, b) => b.pull - a.pull)[0] : set.mvp;
    const tone = over ? matchWinner : winner;
    game.innerHTML = `${shopHead()}
    <article class="gazette ${tone || 'tie'}">
      <header class="gz-mast"><span>${over ? 'FINAL EDITION' : 'LATE EDITION'}</span><b>The Pressroom Gazette</b><span>SET ${set.number} OF ${s.maxSets}</span></header>
      <h2 class="gz-headline">${headline}</h2>
      <p class="gz-deck">${deck}</p>
      <div class="gz-score" aria-label="Match score: Red ${s.score.red}, Black ${s.score.black}">
        <div class="red"><span>RED PLATE</span><b>${s.score.red}</b></div><span class="dash">–</span><div class="black"><b>${s.score.black}</b><span>BLACK PLATE</span></div>
      </div>
      <div class="gz-cols">
        <section><span class="kicker">LONGEST WORD</span>${set.longest ? `<b class="gz-word">${esc(set.longest.word.toUpperCase())}</b><small>${esc(set.longest.name)} · ${TEAM_NAME[set.longest.team]} · +${set.longest.pull}</small>` : '<b class="gz-word">—</b><small>No type was set.</small>'}</section>
        <section><span class="kicker">${over ? 'PRINTER OF THE MATCH' : 'PRINTER OF THE SET'}</span>${star && star.pull > 0 ? `<b class="gz-word ${star.team}">${esc(star.name)}</b><small>${TEAM_NAME[star.team] || ''} · ${star.pull} pull from ${star.words} ${star.words === 1 ? 'word' : 'words'}</small>` : '<b class="gz-word">—</b><small>Nobody pulled.</small>'}</section>
        <section><span class="kicker">TYPE SET THIS ROUND</span><b class="gz-word"><span class="red">${set.red}</span> · ${set.black}</b><small>Red words · Black words</small></section>
      </div>
      ${set.caseStats ? `<p class="gz-case"><span class="kicker">FROM THE TYPE CASE</span>${['red', 'black'].map(team => `<span class="${team}"><b>${TEAM_NAME[team]}:</b> out of sorts ${set.caseStats[team].short}× · ${set.caseStats[team].rare} rare sort${set.caseStats[team].rare === 1 ? '' : 's'} spent (J Q X Z K V)</span>`).join('')}</p>` : ''}
      <div class="gz-words">${['red', 'black'].map(team => `<div><span class="kicker ${team}">${TEAM_NAME[team].toUpperCase()} · BEST TYPE</span><div class="chips">${set.topWords[team].map(w => `<span class="chip ${team}">${esc(w.word.toUpperCase())} <b>+${w.pull}</b></span>`).join('') || '<span class="muted">None</span>'}</div></div>`).join('')}</div>
      ${over ? `<table class="gz-history"><thead><tr><th>Set</th><th>Category</th><th>Winner</th><th>Words</th></tr></thead><tbody>${s.sets.map(x => `<tr><td>${x.number}</td><td>${esc(x.category)}</td><td class="${x.winner || ''}">${x.winner ? TEAM_NAME[x.winner] : 'Dead heat'}</td><td>${x.red} – ${x.black}</td></tr>`).join('')}</tbody></table>` : ''}
      ${over ? `<div class="gz-press"><div><span class="kicker">YOUR PRESS RUN</span><b>${me() ? `${me().words} words · ${me().pull} pull` : 'Watching'}</b></div><span data-fx-chip></span><button class="button ghost small" data-action="share">Share result</button></div>` : ''}
      <footer class="gz-foot">
        ${isHost()
          ? `<button class="button red big" data-action="${over ? 'rematch' : 'next'}">${over ? 'Rematch · same plates' : 'Next category'} <span aria-hidden="true">→</span></button>`
          : `<p class="waiting">Waiting for ${esc(hostName())} to ${over ? 'call a rematch' : 'roll the next sheet'}<span class="dots" aria-hidden="true"></span></p>`}
        ${!over && mine ? `<button class="link-button" data-action="switch" data-team="${mine === 'red' ? 'black' : 'red'}">Switch to the ${mine === 'red' ? 'Black' : 'Red'} Plate</button>` : ''}
      </footer>
    </article>`;
    FX.paintChips();
    if (fresh) {
      processSet();
      if (winner && winner === mine) setTimeout(() => FX.burst($('.gz-headline'), { count: 34, spread: 1.2 }), 300);
      sound.play(winner && winner === mine ? 'win' : 'bell');
      if (winner && winner === mine) buzz([40, 60, 40, 60, 120]);
      announce(`${headline}. ${how} Match score: Red ${s.score.red}, Black ${s.score.black}.`);
    }
  }

  // ---------- Actions ----------
  game.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]'); if (!button) return;
    const action = button.dataset.action;
    if (action === 'switch') send('switch', { team: button.dataset.team });
    if (action === 'start' || action === 'next') send('start');
    if (action === 'rematch') send('rematch');
    if (action === 'addBot') send('addBot', { team: button.dataset.team });
    if (action === 'removeBot') send('removeBot', { id: button.dataset.id });
    if (action === 'share') { const message = await FX.share(shareText(), 'Pressroom Pull'); if (message) toast(message); }
    if (action === 'strike') send('strike', { id: button.dataset.id });
    if (action === 'leave') { leaving = true; send('leave'); socket?.close(); forget(); showLanding(); }
    if (action === 'invite') {
      const url = `${location.origin}/?room=${state.code}`;
      if (navigator.share && matchMedia('(pointer: coarse)').matches) { try { await navigator.share({ title: 'Pressroom Pull', text: `Join my print shop: ${state.code}`, url }); return; } catch { return; } }
      try { await navigator.clipboard.writeText(url); toast('Invite link copied. Call in the crew.'); } catch { toast(`Shop code ${state.code}`); }
    }
  });

  if (saved.token && saved.code && (!linkCode || linkCode === saved.code)) silentJoin = true, connect({ type: 'join', code: saved.code, token: saved.token, name: saved.name });
})();
