// うそつきパス - サーバー（依存なし Node）
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createGame, passCard, decide, playerById, KINDS, KIND_IDS } from './engine.mjs';

const PORT = process.env.PORT || 3000;
const HTML = existsSync(new URL('./public/index.html', import.meta.url))
  ? readFileSync(new URL('./public/index.html', import.meta.url), 'utf8')
  : readFileSync(new URL('./index.html', import.meta.url), 'utf8');

const rooms = new Map();
const BOT_NAMES = ['ボット・タロウ', 'ボット・ハナ', 'ボット・ジロウ', 'ボット・サクラ', 'ボット・ゴロー'];
const code4 = () => { const s = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let c = ''; for (let i = 0; i < 4; i++) c += s[Math.floor(Math.random() * s.length)]; return rooms.has(c) ? code4() : c; };

function newRoom(hostName) {
  const code = code4();
  const host = { id: randomUUID().slice(0, 8), token: randomUUID(), name: hostName, isBot: false };
  const room = { code, hostId: host.id, players: [host], game: null, createdAt: Date.now(), lastActive: Date.now(), botNextAt: 0, log: [] };
  rooms.set(code, room);
  return { room, me: host };
}
function auth(room, playerId, token) {
  const p = room?.players.find(x => x.id === playerId);
  return p && p.token === token ? p : null;
}
const totalC = counts => KIND_IDS.reduce((s, id) => s + counts[id], 0);

// ---------- ボット ----------
function botChoosePass(g, bot) {
  const others = g.players.filter(p => p.id !== bot.id && p.id !== g.noPassBack);
  // 狙い：前の枚数が多い相手。3枚ある種を持っていたらそれを本当で渡してダウトを誘う
  let target = others[0], bestScore = -1;
  for (const o of others) {
    let score = totalC(o.pile) + Math.random() * 2;
    for (const id of KIND_IDS) if (o.pile[id] === 3 && bot.hand[id] > 0) score += 5;
    if (score > bestScore) { bestScore = score; target = o; }
  }
  let card = null;
  for (const id of KIND_IDS) if (target.pile[id] === 3 && bot.hand[id] > 0) card = id;
  if (!card) {
    const held = KIND_IDS.filter(id => bot.hand[id] > 0);
    card = held[Math.floor(Math.random() * held.length)];
  }
  let declared = card;
  if (Math.random() < 0.45) {
    // 嘘：場＋自分の手札で見えている枚数が少ない種を名乗る（ありそうに見せる）
    const seen = id => g.players.reduce((s, p) => s + p.pile[id], 0) + bot.hand[id];
    const plausible = KIND_IDS.filter(id => id !== card).sort((a, b) => seen(a) - seen(b));
    declared = plausible[0];
  }
  return { card, target: target.id, declared };
}

function botChooseDecide(g, bot) {
  const { from, declared } = g.pending;
  const st = g.stats[from];
  let lie = st.declared >= 3 ? st.lies / st.declared : 0.45;
  const seen = g.players.reduce((s, p) => s + p.pile[declared], 0) + bot.hand[declared];
  if (seen >= 6) lie += 0.2; else if (seen <= 2) lie -= 0.1;
  lie += (Math.random() - 0.5) * 0.15;
  let threshold = 0.55;
  if (bot.pile[declared] >= 3) threshold = 0.85;      // 自分がリーチの種は疑うのが怖い
  else if (bot.pile[declared] <= 1) threshold = 0.48; // 引き取っても痛くない
  return lie > threshold ? 'doubt' : 'accept';
}

function driveBots(room) {
  const g = room.game;
  if (!g || g.phase === 'finished') return;
  const now = Date.now();
  if (now < room.botNextAt) return;
  try {
    if (g.phase === 'pass') {
      const cur = playerById(g, g.turn);
      if (cur?.isBot) {
        const mv = botChoosePass(g, cur);
        passCard(g, cur.id, mv.card, mv.target, mv.declared);
        room.botNextAt = now + 900 + Math.random() * 900;
      }
    } else if (g.phase === 'decide' && g.pending) {
      const tgt = playerById(g, g.pending.to);
      if (tgt?.isBot) {
        decide(g, tgt.id, botChooseDecide(g, tgt));
        room.botNextAt = now + 900 + Math.random() * 900;
      }
    }
  } catch (e) { /* ボットの手は握りつぶして次tickで再試行 */ }
}
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActive > 2 * 3600 * 1000) { rooms.delete(code); continue; }
    driveBots(room);
  }
}, 400);

// ---------- 状態ビュー ----------
function stateFor(room, me) {
  const g = room.game;
  const base = {
    code: room.code,
    phase: g ? g.phase : 'lobby',
    isHost: me.id === room.hostId,
    players: room.players.map(p => {
      const gp = g ? playerById(g, p.id) : null;
      return {
        id: p.id, name: p.name, isBot: p.isBot, isMe: p.id === me.id,
        handCount: gp ? totalC(gp.hand) : null,
        pile: gp ? gp.pile : null,
        isTurn: g ? (g.phase === 'pass' ? g.turn === p.id : g.pending?.to === p.id) : false,
      };
    }),
    log: g ? g.log.slice(-30) : [],
  };
  if (!g) return base;
  const meG = playerById(g, me.id);
  base.me = {
    hand: meG.hand,
    lastReceived: g.lastReceived?.player === me.id ? g.lastReceived.card : null,
  };
  base.turn = g.turn;
  base.noPassBack = g.noPassBack;
  base.pending = g.pending ? {
    from: g.pending.from, to: g.pending.to, declared: g.pending.declared,
    card: g.pending.from === me.id ? g.pending.card : undefined, // 渡した本人にだけ中身を見せる
  } : null;
  base.stats = g.stats;
  base.loser = g.loser;
  base.loseReason = g.loseReason;
  return base;
}

// ---------- HTTP ----------
function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
async function body(req) { let s = ''; for await (const c of req) s += c; try { return JSON.parse(s || '{}'); } catch { return {}; } }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(HTML); }
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/api/create') {
      const b = await body(req);
      const { room, me } = newRoom(String(b.name || '名無し').slice(0, 12));
      return send(res, 200, { code: room.code, playerId: me.id, token: me.token });
    }
    if (req.method === 'POST' && url.pathname === '/api/join') {
      const b = await body(req);
      const room = rooms.get(String(b.code || '').toUpperCase());
      if (!room) return send(res, 404, { error: 'ルームが見つからない' });
      if (room.game) return send(res, 400, { error: 'ゲーム進行中' });
      if (room.players.length >= 6) return send(res, 400, { error: '満員' });
      const me = { id: randomUUID().slice(0, 8), token: randomUUID(), name: String(b.name || '名無し').slice(0, 12), isBot: false };
      room.players.push(me); room.lastActive = Date.now();
      return send(res, 200, { code: room.code, playerId: me.id, token: me.token });
    }
    const b = req.method === 'POST' ? await body(req) : null;
    const q = url.searchParams;
    const room = rooms.get(String((b?.code || q.get('room') || '')).toUpperCase());
    if (!room) return send(res, 404, { error: 'ルームが見つからない' });
    const me = auth(room, b?.playerId || q.get('player'), b?.token || q.get('token'));
    if (!me) return send(res, 403, { error: '認証エラー' });
    room.lastActive = Date.now();

    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, stateFor(room, me));
    if (req.method === 'POST' && url.pathname === '/api/addbot') {
      if (room.game) return send(res, 400, { error: 'ゲーム進行中' });
      if (room.players.length >= 6) return send(res, 400, { error: '満員' });
      const used = room.players.map(p => p.name);
      const name = BOT_NAMES.find(n => !used.includes(n)) || 'ボット';
      room.players.push({ id: randomUUID().slice(0, 8), token: '-', name, isBot: true });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/start') {
      if (me.id !== room.hostId) return send(res, 403, { error: 'ホストだけが開始できる' });
      if (room.players.length < 3) return send(res, 400, { error: '3人から' });
      room.game = createGame(room.players.map(p => ({ id: p.id, name: p.name, isBot: p.isBot })));
      room.botNextAt = Date.now() + 800;
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/restart') {
      if (me.id !== room.hostId) return send(res, 403, { error: 'ホストだけ' });
      room.game = null;
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      const g = room.game;
      if (!g) return send(res, 400, { error: 'ゲームが始まっていない' });
      if (b.action === 'pass') { passCard(g, me.id, b.card, b.target, b.declared); return send(res, 200, { ok: true }); }
      if (b.action === 'decide') { decide(g, me.id, b.choice); return send(res, 200, { ok: true }); }
      return send(res, 400, { error: '不明なアクション' });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 400, { error: String(e.message || e) });
  }
});
server.listen(PORT, () => console.log('usotsuki-pass server on :' + PORT));
