const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const categories = JSON.parse(fs.readFileSync(path.join(ROOT, 'categories.json'), 'utf8'));
// Practice bots draw from a private word list per category (never served to players).
const BOT_WORDS = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(ROOT, 'botwords.json'), 'utf8'))).map(([k, v]) => [k, v.split(/\s+/).filter(w => w.length >= 3)]));
const BOT_NAMES = ['Old Hob', 'Nell Quoin', 'Silas Ink', 'Peg Leading'];
const SCALE = Number(process.env.TIME_SCALE) || 1;

// Game rules (PRD section 3).
const EDGE = 12, PREVIEW_MS = 5000, PULL_MS = 75000, SUDDEN_MS = 10000, PAUSE_MS = 20000;
const MAX_PLAYERS = 12, MAX_SETS = 3, SETS_TO_WIN = 2, WORDS_PER_SECOND = 4;
const HOT_LETTERS = 'BCDFGHKLMNPRSTW';
const ROOM_IDLE_MS = 10 * 60 * 1000, HOST_GRACE_MS = 15000;

// Profanity and slur blocklist, ROT13-encoded to keep the source readable. Matches whole words and simple inflections.
const BLOCKED = new Set('shpx shpxre shpxvat shpxrq zbgureshpxre fuvg fuvggl ohyyfuvg phag onfgneq qvpx qvpxurnq juber fyhg gjng jnax jnaxre cvff nffubyr nefrubyr obyybpxf avttre avttn snttbg snt ergneq xvxr puvax fcvp genaal jrgonpx tbbx'
  .split(' ').map(w => w.replace(/[a-z]/g, c => String.fromCharCode((c.charCodeAt(0) - 84) % 26 + 97))));
const isBlocked = word => BLOCKED.has(word) || ['s', 'es', 'ed', 'ing', 'er', 'ers'].some(end => word.endsWith(end) && BLOCKED.has(word.slice(0, -end.length)));

const rooms = new Map();
const PUBLIC_FILES = { '/': 'index.html', '/index.html': 'index.html', '/client.js': 'client.js', '/fx.js': 'fx.js', '/style.css': 'style.css' };
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8' };
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type':'text/plain' }); return res.end('ok'); }
  const file = PUBLIC_FILES[pathname];
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)], 'Cache-Control':'no-store' });
  fs.createReadStream(path.join(ROOT, file)).pipe(res);
});
const sockets = new Set();

// Minimal RFC 6455 text socket support keeps this tiny game dependency-free.
function frame(opcode, payload=Buffer.alloc(0)) {
  payload=Buffer.isBuffer(payload)?payload:Buffer.from(payload);
  let head;
  if(payload.length<126){head=Buffer.from([0x80|opcode,payload.length]);}
  else if(payload.length<65536){head=Buffer.alloc(4);head[0]=0x80|opcode;head[1]=126;head.writeUInt16BE(payload.length,2);}
  else {head=Buffer.alloc(10);head[0]=0x80|opcode;head[1]=127;head.writeBigUInt64BE(BigInt(payload.length),2);}
  return Buffer.concat([head,payload]);
}
class Peer {
  constructor(socket, initial=Buffer.alloc(0)) { this.socket=socket;this.buffer=initial;this.readyState=1;this.handlers={};this.recent=[];socket.on('data',b=>this.consume(b));socket.on('close',()=>this.closed());socket.on('error',()=>this.closed());if(initial.length)this.consume(initial); }
  on(name,fn){(this.handlers[name]??=[]).push(fn);return this;}
  emit(name,value){for(const fn of this.handlers[name]||[])fn(value);}
  send(data){if(this.readyState===1)this.socket.write(frame(1,data));}
  close(){if(this.readyState!==1)return;this.readyState=2;this.socket.end(frame(8));this.closed();}
  closed(){if(this.readyState===3)return;this.readyState=3;sockets.delete(this);this.emit('close');}
  consume(chunk){this.buffer=Buffer.concat([this.buffer,chunk]);while(this.buffer.length>=2){const b0=this.buffer[0],b1=this.buffer[1],opcode=b0&15,masked=!!(b1&128);let len=b1&127,offset=2;
      if(len===126){if(this.buffer.length<4)return;len=this.buffer.readUInt16BE(2);offset=4;}else if(len===127){if(this.buffer.length<10)return;const n=this.buffer.readBigUInt64BE(2);if(n>2048n)return this.close();len=Number(n);offset=10;}
      if(len>2048)return this.close();const maskBytes=masked?4:0;if(this.buffer.length<offset+maskBytes+len)return;let data=this.buffer.subarray(offset+maskBytes,offset+maskBytes+len);if(masked){data=Buffer.from(data);for(let i=0;i<data.length;i++)data[i]^=this.buffer[offset+(i%4)];}this.buffer=this.buffer.subarray(offset+maskBytes+len);
      if(opcode===8){this.socket.end(frame(8,data));this.closed();return;}if(opcode===9){this.socket.write(frame(10,data));continue;}if(opcode===1)this.emit('message',data);
    }}
}
server.on('upgrade',(req,socket)=>{const key=req.headers['sec-websocket-key'];if(!key||req.headers.upgrade?.toLowerCase()!=='websocket'){socket.destroy();return;}
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');const peer=new Peer(socket);sockets.add(peer);
  peer.on('message',buf=>{const now=Date.now();peer.recent=peer.recent.filter(t=>now-t<1000);if(peer.recent.length>=20)return;peer.recent.push(now);
    try{handle(peer,JSON.parse(buf.toString()));}catch(e){send(peer,'error',{message:'The foreman lost that order. Try again.'});}});
  peer.on('close',()=>onDisconnect(peer));});

const id = () => crypto.randomBytes(12).toString('hex');
const code = () => { let s; do { s=''; for(let i=0;i<4;i++) s += 'ABCDEFGHJKLMNPQRSTUVWXYZ'[crypto.randomInt(24)]; } while(rooms.has(s)); return s; };
const pick = list => list[crypto.randomInt(list.length)];
const send = (ws, type, data={}) => { if(ws?.readyState===1) ws.send(JSON.stringify({type,...data})); };
const other = team => team==='red' ? 'black' : 'red';
const leader = room => room.position<0 ? 'red' : 'black';
const live = room => room.phase==='pull' || room.phase==='sudden';
const connected = room => [...room.players.values()].filter(p=>p.connected);
const humans = room => connected(room).filter(p=>!p.isBot);
const teamSize = (room, team) => connected(room).filter(p=>p.team===team).length;
const matchOver = room => room.phase==='result' && (room.score.red>=SETS_TO_WIN || room.score.black>=SETS_TO_WIN || room.setNumber>=MAX_SETS);

function publicRoom(room) {
  return { code:room.code, phase:room.phase, hostId:room.hostId, serverNow:Date.now(),
    players:connected(room).map(({id,name,team,words,pull,isBot})=>({id,name,team,words,pull,isBot:!!isBot})), practice:!!room.practice,
    score:room.score, setNumber:room.setNumber, maxSets:MAX_SETS, edge:EDGE, matchOver:matchOver(room),
    category:room.category, hotLetter:room.hotLetter, position:room.position, endsAt:room.endsAt, previewEndsAt:room.previewEndsAt, suddenEndsAt:room.suddenEndsAt,
    pause:room.pause, winner:room.winner, feed:room.feed.slice(-40), tally:tally(room), sets:room.sets, balanced:room.balanced, usedCount:room.used.size };
}
function tally(room) {
  const count=team=>{const kept=room.feed.filter(x=>x.team===team&&!x.struck);return {words:kept.length,pull:kept.reduce((n,x)=>n+x.pull,0)};};
  return { red:count('red'), black:count('black') };
}
// Each player's rejoin token is private: only they receive it, unlike their public id.
function broadcast(room) { const state=publicRoom(room); for(const p of room.players.values()) if(p.connected) send(p.ws,'state',{state,selfId:p.id,token:p.token}); }
function roomFor(ws) { return ws.player && rooms.get(ws.player.room); }

function finish(room, winner, reason) {
  if(!live(room)) return;
  const kept=room.feed.filter(x=>!x.struck), byTeam=team=>kept.filter(x=>x.team===team);
  const totals=new Map(); for(const x of kept) totals.set(x.playerId,{name:x.name,team:x.team,pull:(totals.get(x.playerId)?.pull||0)+x.pull,words:(totals.get(x.playerId)?.words||0)+1});
  room.phase='result'; room.winner=winner; room.pause=null;
  room.sets.push({ number:room.setNumber, winner, reason, category:room.category, hotLetter:room.hotLetter, seconds:Math.round((Date.now()-room.startedAt)/1000),
    red:byTeam('red').length, black:byTeam('black').length,
    longest:[...kept].sort((a,b)=>b.word.length-a.word.length||b.pull-a.pull)[0]||null,
    mvp:[...totals.values()].sort((a,b)=>b.pull-a.pull)[0]||null,
    topWords:{ red:byTeam('red').sort((a,b)=>b.pull-a.pull).slice(0,4), black:byTeam('black').sort((a,b)=>b.pull-a.pull).slice(0,4) } });
  if(winner) room.score[winner]++;
  broadcast(room);
}
function startSet(room) {
  if(room.phase==='result') { if(matchOver(room)) return; room.setNumber++; }
  // Late joiners and spectators take the smaller plate between sets.
  for(const p of connected(room)) if(!p.team) p.team = teamSize(room,'red')<=teamSize(room,'black') ? 'red' : 'black';
  const fresh=categories.filter(c=>!room.categoryHistory.includes(c));
  room.category=pick(fresh.length?fresh:categories); room.categoryHistory.push(room.category);
  room.hotLetter=pick(HOT_LETTERS);
  for(const p of room.players.values()) if(p.isBot) p.nextAt=0;
  room.phase='preview'; room.previewEndsAt=Date.now()+PREVIEW_MS; room.position=0; room.feed=[]; room.used=new Set(); room.winner=null; room.pause=null;
  broadcast(room);
}
function beginPull(room) {
  room.phase='pull'; room.startedAt=Date.now(); room.endsAt=room.startedAt+PULL_MS; room.suddenEndsAt=null;
  room.balanced=Math.abs(teamSize(room,'red')-teamSize(room,'black'))>=2;
  broadcast(room);
}
function resumeIfPaused(room, player) {
  if(!room.pause || player.team!==room.pause.team) return;
  const held=Date.now()-room.pause.startedAt; room.endsAt+=held; if(room.suddenEndsAt) room.suddenEndsAt+=held; room.pause=null;
}
function addBot(room, team) {
  const used=new Set([...room.players.values()].map(p=>p.name));
  const name=BOT_NAMES.find(n=>!used.has(n)); if(!name||connected(room).length>=MAX_PLAYERS) return;
  team ||= teamSize(room,'red')<=teamSize(room,'black') ? 'red' : 'black';
  const bot={id:id(),token:null,name,team,ws:null,connected:true,isBot:true,joinedAt:Date.now(),rate:[],words:0,pull:0,nextAt:0};
  room.players.set(bot.id,bot);
}
// Bots set a word every few seconds from the category list, preferring hot-letter words a third of the time.
function runBots(room, now) {
  if(!live(room)||room.pause) return;
  for(const bot of room.players.values()) {
    if(!live(room)) return;
    if(!bot.isBot||!bot.team) continue;
    if(!bot.nextAt) { bot.nextAt=now+(1500+crypto.randomInt(2500))*SCALE; continue; }
    if(now<bot.nextAt) continue;
    bot.nextAt=now+(room.phase==='sudden'?2500+crypto.randomInt(3000):3400+crypto.randomInt(3200))*SCALE;
    const pool=(BOT_WORDS[room.category]||[]).filter(w=>!room.used.has(w)&&w!==room.category.toLowerCase());
    if(!pool.length) continue;
    const hot=pool.filter(w=>w.includes(room.hotLetter.toLowerCase()));
    setWord(room, bot, pick(hot.length&&crypto.randomInt(3)===0?hot:pool));
  }
}
function createRoom(ws,name,practice) {
  const c=code(), playerId=id();
  const room={code:c,practice:!!practice,hostId:playerId,players:new Map(),phase:'lobby',score:{red:0,black:0},setNumber:1,position:0,feed:[],used:new Set(),sets:[],categoryHistory:[],pause:null,emptySince:null};
  room.players.set(playerId,{id:playerId,token:id(),name,team:'red',ws,connected:true,joinedAt:Date.now(),rate:[],words:0,pull:0}); rooms.set(c,room); ws.player={room:c,id:playerId};
  if(practice) addBot(room,'black');
  broadcast(room);
}

function handle(ws,msg) {
  const room=roomFor(ws), player=room?.players.get(ws.player.id);
  if(msg.type==='create'||msg.type==='practice') { const name=cleanName(msg.name); if(!name)return send(ws,'error',{message:'Name must be 2–14 characters.'}); createRoom(ws,name,msg.type==='practice'); return; }
  if(msg.type==='join') {
    const c=String(msg.code||'').toUpperCase(), name=cleanName(msg.name), r=rooms.get(c);
    if(!r)return send(ws,'error',{message:'Shop code not found.',code:'no-room'});
    const returning=msg.token && [...r.players.values()].find(x=>x.token===msg.token);
    if(returning){const p=returning;if(p.connected&&p.ws!==ws)send(p.ws,'error',{message:'You opened this shop in another tab.'});p.ws=ws;p.connected=true;ws.player={room:c,id:p.id};resumeIfPaused(r,p);broadcast(r);return;}
    if(!name)return send(ws,'error',{message:'Name must be 2–14 characters.'});
    if(connected(r).length>=MAX_PLAYERS)return send(ws,'error',{message:'This shop is full. Twelve printers at most.'});
    if([...r.players.values()].some(p=>p.name.toLowerCase()===name.toLowerCase()))return send(ws,'error',{message:'That name is already set in this shop.'});
    // Mid-set joiners watch, unless a plate has emptied and the press is paused for them.
    const team=r.pause ? r.pause.team : (r.phase==='preview'||live(r)) ? null : (teamSize(r,'red')<=teamSize(r,'black')?'red':'black');
    const p={id:id(),token:id(),name,team,ws,connected:true,joinedAt:Date.now(),rate:[],words:0,pull:0};r.players.set(p.id,p);ws.player={room:c,id:p.id};resumeIfPaused(r,p);broadcast(r);return;
  }
  if(!room||!player)return send(ws,'error',{message:'Join a shop first.'});
  if(msg.type==='leave') { room.players.delete(player.id); ws.player=null; afterDeparture(room,player,true); return; }
  if(msg.type==='switch') { if(room.phase!=='lobby'&&room.phase!=='result')return; if(msg.team==='red'||msg.team==='black')player.team=msg.team;broadcast(room); }
  if(msg.type==='start') {
    if(player.id!==room.hostId)return send(ws,'error',{message:'Only the Foreman can start the press.'});
    if(room.phase!=='lobby'&&room.phase!=='result')return;
    const spare=connected(room).filter(p=>!p.team).length;
    if(teamSize(room,'red')+teamSize(room,'black')+spare<2 || (!spare && (!teamSize(room,'red')||!teamSize(room,'black'))))return send(ws,'error',{message:'Put a printer on both plates first.'});
    startSet(room);
  }
  if(msg.type==='word') {
    if(!live(room))return send(ws,'reject',{message:'The press is not running.'});
    if(room.pause)return send(ws,'reject',{message:'The press is paused. Hold the line.'});
    if(!player.team)return send(ws,'reject',{message:'You join a plate at the next set.'});
    const now=Date.now();player.rate=player.rate.filter(t=>now-t<1000);if(player.rate.length>=WORDS_PER_SECOND)return send(ws,'reject',{message:'Easy on the keys'});player.rate.push(now);
    const result=setWord(room,player,msg.word);
    if(result.error)return send(ws,'reject',{message:result.error,word:result.word});
    send(ws,'accepted',result.item);
    afterWord(room);
  }
  if(msg.type==='addBot'&&player.id===room.hostId&&(room.phase==='lobby'||room.phase==='result')) { addBot(room,msg.team==='red'||msg.team==='black'?msg.team:null); broadcast(room); }
  if(msg.type==='removeBot'&&player.id===room.hostId&&(room.phase==='lobby'||room.phase==='result')) { const b=room.players.get(msg.id); if(b?.isBot){room.players.delete(b.id);broadcast(room);} }
  if(msg.type==='strike') {
    if(player.id!==room.hostId)return send(ws,'error',{message:'Only the Foreman can strike type.'});
    const item=room.feed.find(x=>x.id===msg.id); if(!live(room)||!item||item.struck)return;
    item.struck=true; room.position=Math.max(-EDGE,Math.min(EDGE,room.position-(item.team==='red'?-1:1)*item.pull));
    const author=room.players.get(item.playerId); if(author){author.words--;author.pull-=item.pull;}
    if(Math.abs(room.position)>=EDGE)finish(room,leader(room),'edge'); else broadcast(room);
  }
  if(msg.type==='rematch'&&player.id===room.hostId&&matchOver(room)){
    room.phase='lobby';room.score={red:0,black:0};room.setNumber=1;room.sets=[];room.categoryHistory=[];room.position=0;room.feed=[];room.used=new Set();room.winner=null;
    for(const p of room.players.values()){p.words=0;p.pull=0;}
    broadcast(room);
  }
}
// Shared by players and bots: validates a word, moves the slug and records it.
function setWord(room, player, value) {
  const raw=String(value||'').trim().replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g,'').toLowerCase();
  let error='';
  if(!/^[a-z]+$/.test(raw))error='Letters only, please';
  else if(raw.length<3)error='Too short for the press';
  else if(raw.length>20||!/[aeiouy]/.test(raw)||/(.)\1{3}/.test(raw))error='That is not a word, friend';
  else if(isBlocked(raw))error='That word is not allowed';
  else if(raw===room.category.toLowerCase())error='That is the category itself';
  else if(room.used.has(raw)){const first=room.feed.find(x=>x.word===raw);error=`Already set in type${first?` by ${first.name}`:''}`;}
  if(error)return {error,word:raw};
  room.used.add(raw);
  const tier=raw.length<=4?1:raw.length<=7?2:3, hot=raw.includes(room.hotLetter.toLowerCase());
  let pull=Math.min(6,tier*(hot?2:1)), bonus=false;
  if(room.balanced&&teamSize(room,player.team)<teamSize(room,other(player.team))){pull++;bonus=true;}
  room.position=Math.max(-EDGE,Math.min(EDGE,room.position+(player.team==='red'?-1:1)*pull));
  room.feed.push({id:id(),playerId:player.id,name:player.name,team:player.team,word:raw,pull,hot,bonus,struck:false,ts:Date.now()});
  player.words++; player.pull+=pull;
  if(player.isBot) afterWord(room);
  return {item:{word:raw,pull,hot,bonus}};
}
function afterWord(room) {
  if(Math.abs(room.position)>=EDGE)finish(room,leader(room),'edge');
  else if(room.phase==='sudden'&&room.position!==0)finish(room,leader(room),'sudden');
  else broadcast(room);
}
function cleanName(value){const s=String(value||'').trim().replace(/[<>]/g,'');return s.length>=2&&s.length<=14?s:'';}
function passForeman(room) { const next=humans(room).sort((a,b)=>a.joinedAt-b.joinedAt)[0]; if(next) room.hostId=next.id; }
function afterDeparture(room, player, left) {
  // A refresh or dropped signal keeps the Foreman role for a short grace period; leaving hands it on at once.
  if(player.id===room.hostId){ if(left) passForeman(room); else room.hostGraceUntil=Date.now()+HOST_GRACE_MS; }
  // An emptied plate pauses the set for 20 seconds before it is forfeited.
  if(live(room)&&player.team&&!room.pause&&teamSize(room,player.team)===0){const now=Date.now();room.pause={team:player.team,startedAt:now,until:now+PAUSE_MS};}
  broadcast(room);
}
function onDisconnect(ws){const room=roomFor(ws);if(!room)return;const player=room.players.get(ws.player.id);if(!player||player.ws!==ws)return;player.connected=false;afterDeparture(room,player);}

// One clock drives every room, so phase changes are ordered by the server alone.
setInterval(()=>{
  const now=Date.now();
  for(const room of rooms.values()){
    if(!humans(room).length){room.emptySince??=now;if(now-room.emptySince>ROOM_IDLE_MS)rooms.delete(room.code);continue;}
    room.emptySince=null;
    if(!room.players.get(room.hostId)?.connected&&now>=(room.hostGraceUntil||0)){passForeman(room);broadcast(room);}
    runBots(room,now);
    if(room.phase==='preview'&&now>=room.previewEndsAt)beginPull(room);
    else if(room.pause){if(now>=room.pause.until)finish(room,other(room.pause.team),'forfeit');}
    else if(room.phase==='pull'&&now>=room.endsAt){if(room.position===0){room.phase='sudden';room.suddenEndsAt=now+SUDDEN_MS;broadcast(room);}else finish(room,leader(room),'time');}
    else if(room.phase==='sudden'&&now>=room.suddenEndsAt)finish(room,room.position===0?null:leader(room),room.position===0?'tie':'sudden');
  }
},200).unref();
server.listen(PORT,()=>console.log(`Pressroom Pull is running at http://localhost:${PORT}`));
