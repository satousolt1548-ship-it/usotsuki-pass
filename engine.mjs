// うそつきパス - ゲームエンジン（ゴキブリポーカー型ブラフゲーム）
export const KINDS = [
  { id: 'roach',    name: 'ゴキブリ', emoji: '🪳' },
  { id: 'rat',      name: 'ネズミ',   emoji: '🐀' },
  { id: 'bat',      name: 'コウモリ', emoji: '🦇' },
  { id: 'frog',     name: 'カエル',   emoji: '🐸' },
  { id: 'scorpion', name: 'サソリ',   emoji: '🦂' },
  { id: 'snake',    name: 'ヘビ',     emoji: '🐍' },
  { id: 'spider',   name: 'クモ',     emoji: '🕷️' },
  { id: 'mosquito', name: 'カ',       emoji: '🦟' },
];
export const KIND_IDS = KINDS.map(k => k.id);
const COPIES = 8;      // 1種あたりの枚数
export const LOSE_COUNT = 4; // 同種が前に4枚で負け

function emptyCounts() { const o = {}; for (const id of KIND_IDS) o[id] = 0; return o; }
function total(counts) { return KIND_IDS.reduce((s, id) => s + counts[id], 0); }
function maxKind(counts) { return Math.max(...KIND_IDS.map(id => counts[id])); }
function shuffle(a, rnd) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// players: [{id, name, isBot}]
export function createGame(players, rnd = Math.random) {
  const deck = [];
  for (const id of KIND_IDS) for (let i = 0; i < COPIES; i++) deck.push(id);
  shuffle(deck, rnd);
  const ps = players.map(p => ({ ...p, hand: emptyCounts(), pile: emptyCounts() }));
  deck.forEach((card, i) => { ps[i % ps.length].hand[card]++; });
  const g = {
    players: ps,
    phase: 'pass',           // pass: 現プレイヤーが渡す / decide: 相手が受けるかダウト / finished
    turn: ps[0].id,          // 渡す人
    pending: null,           // {from, to, card, declared}
    noPassBack: null,        // 受け取った直後の人が「渡してきた人」に返せない制限
    lastReceived: null,      // {player, card} 受け取った本人だけに知らせる
    stats: {},               // 宣言者ごとの {declared, lies}（ダウトで公開された分だけ）
    log: [],
    loser: null,
    loseReason: null,
    round: 1,
  };
  for (const p of ps) g.stats[p.id] = { declared: 0, lies: 0 };
  g.log.push('ゲーム開始。最初の渡し手は ' + ps[0].name + '。');
  return g;
}

export function playerById(g, id) { return g.players.find(p => p.id === id); }

function checkLose(g, p) {
  if (maxKind(p.pile) >= LOSE_COUNT) {
    g.phase = 'finished';
    g.loser = p.id;
    const kind = KIND_IDS.find(id => p.pile[id] >= LOSE_COUNT);
    g.loseReason = `${p.name} の前に ${KINDS.find(k => k.id === kind).name} が${LOSE_COUNT}枚集まった`;
    g.log.push('🏁 ' + g.loseReason + '。' + p.name + ' の負け！');
    return true;
  }
  return false;
}

// 手札切れで終わる場合：前に一番多く集めた人が負け
function finishByExhaustion(g) {
  g.phase = 'finished';
  let loser = g.players[0], best = -1, bestMax = -1;
  for (const p of g.players) {
    const t = total(p.pile), m = maxKind(p.pile);
    if (t > best || (t === best && m > bestMax)) { loser = p; best = t; bestMax = m; }
  }
  g.loser = loser.id;
  g.loseReason = `手札が尽きた。前のカードが一番多い ${loser.name}（${best}枚）の負け`;
  g.log.push('🏁 ' + g.loseReason + '。');
}

// 渡す番の開始時チェック：手札が無ければ終了
function beginPassTurn(g, playerId) {
  g.turn = playerId;
  g.phase = 'pass';
  const p = playerById(g, playerId);
  if (total(p.hand) === 0) { finishByExhaustion(g); }
}

export function passCard(g, fromId, card, targetId, declared) {
  if (g.phase !== 'pass') throw new Error('今は渡すフェーズではない');
  if (g.turn !== fromId) throw new Error('あなたの番ではない');
  const from = playerById(g, fromId), to = playerById(g, targetId);
  if (!to || targetId === fromId) throw new Error('渡す相手が不正');
  if (g.noPassBack === targetId) throw new Error('渡してきた人にそのまま返せない');
  if (!KIND_IDS.includes(card) || !KIND_IDS.includes(declared)) throw new Error('カードが不正');
  if (from.hand[card] <= 0) throw new Error('そのカードを持っていない');
  from.hand[card]--;
  g.pending = { from: fromId, to: targetId, card, declared };
  g.phase = 'decide';
  g.lastReceived = null;
  g.noPassBack = null;
  const d = KINDS.find(k => k.id === declared);
  g.log.push(`${from.name} → ${to.name}：「これは ${d.emoji}${d.name}」`);
  return g;
}

// action: 'accept' | 'doubt'（ダウトは必ず「見る前」に決める）
export function decide(g, playerId, action) {
  if (g.phase !== 'decide' || !g.pending) throw new Error('今は判断フェーズではない');
  const { from, to, card, declared } = g.pending;
  if (playerId !== to) throw new Error('判断できるのは渡された人だけ');
  const fromP = playerById(g, from), toP = playerById(g, to);
  if (action === 'accept') {
    toP.hand[card]++;
    g.lastReceived = { player: to, card };
    g.pending = null;
    g.noPassBack = from; // 受けた人は渡してきた人に返せない
    g.log.push(`${toP.name} は受け取った。`);
    beginPassTurn(g, to);
    return { result: 'accepted' };
  }
  if (action === 'doubt') {
    const truth = card === declared;
    g.stats[from].declared++;
    if (!truth) g.stats[from].lies++;
    const c = KINDS.find(k => k.id === card);
    g.pending = null;
    let taker;
    if (truth) {
      toP.pile[card]++; taker = toP;
      g.log.push(`ダウト！ 本当に ${c.emoji}${c.name} だった。${toP.name} が引き取る。`);
    } else {
      fromP.pile[card]++; taker = fromP;
      g.log.push(`ダウト成功！ 本当は ${c.emoji}${c.name}。${fromP.name} が引き取る。`);
    }
    if (checkLose(g, taker)) return { result: truth ? 'doubt_true' : 'doubt_lie' };
    g.round++;
    beginPassTurn(g, taker.id); // 引き取った人が次に渡す
    return { result: truth ? 'doubt_true' : 'doubt_lie' };
  }
  throw new Error('不明なアクション');
}
