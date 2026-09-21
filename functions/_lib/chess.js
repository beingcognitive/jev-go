// Chess rules come from the vendored chess.js. This module adds: replay of a SAN move list, board rendering
// for Jev's state, and per-move annotations (material, safety, checks, one-ply opponent replies).

import { Chess } from "./vendor/chess.js";

export const MAX_PLIES = 400;
export const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const NAME = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
export const colorOf = (xo) => (xo === "X" ? "w" : "b");   // X = White, O = Black
export const otherColor = (c) => (c === "w" ? "b" : "w");
const FILES = "abcdefgh";

// A game is a chess.js instance plus `reps`: counts of positions reached since the last capture or pawn
// move (the only ones that can repeat). Carrying `reps` lets a position loaded from a snapshot still
// detect threefold repetition, which chess.js can only do from a full move history.
export const positionKey = (c) => c.fen().split(" ").slice(0, 4).join(" ");
export function newGame() {
  const c = new Chess();
  c.reps = { [positionKey(c)]: 1 };
  return c;
}
// Apply one move (SAN string or {from,to,promotion}); throws on illegal or null moves; updates `reps`.
export function applyMove(c, input) {
  if (status(c).over) throw new Error("game is over");
  let m;
  try { m = c.move(input); } catch { throw new Error("illegal move"); }
  if (m.san === "--") { c.undo(); throw new Error("illegal move"); } // chess.js accepts "--"; standard chess does not
  if (c.reps) {
    if (m.captured || m.piece === "p") c.reps = {};
    const k = positionKey(c);
    c.reps[k] = (c.reps[k] || 0) + 1;
  }
  return m;
}
export function replay(moves) {
  if (!Array.isArray(moves)) throw new Error("moves must be an array");
  if (moves.length > MAX_PLIES) throw new Error(`too many moves (max ${MAX_PLIES})`);
  const c = newGame();
  for (let i = 0; i < moves.length; i++) {
    const san = moves[i];
    if (typeof san !== "string" || san.length > 10) throw new Error(`bad move ${i}`);
    try { applyMove(c, san); } catch (e) { throw new Error(e.message === "game is over" ? "game is over" : `move ${i} ${san} illegal`); }
  }
  return c;
}
export const plies = (c) => 2 * (c.moveNumber() - 1) + (c.turn() === "b" ? 1 : 0);

// Snapshot <-> game. The snapshot is what the client carries between requests (signed by the handler).
export const snapshot = (c) => ({ v: 1, fen: c.fen(), reps: c.reps || {} });
export function fromSnapshot(s) {
  if (!s || s.v !== 1 || typeof s.fen !== "string" || typeof s.reps !== "object") throw new Error("bad state");
  let c;
  try { c = new Chess(s.fen); } catch { throw new Error("bad state"); }
  c.reps = s.reps;
  return c;
}

// 8 strings, rank 8 first; uppercase = white, lowercase = black, "." = empty.
export function boardRows(c) {
  return c.board().map((rank) => rank.map((sq) => (sq ? (sq.color === "w" ? sq.type.toUpperCase() : sq.type) : ".")).join(""));
}
export function render(c) {
  const rows = boardRows(c);
  const lines = rows.map((r, i) => `${8 - i} ${r.split("").join(" ")}`);
  lines.push("  " + FILES.split("").join(" "));
  return lines.join("\n");
}
export function material(c) {
  const m = { w: 0, b: 0 };
  for (const rank of c.board()) for (const sq of rank) if (sq) m[sq.color] += VALUE[sq.type];
  return m;
}
export function status(c) {
  if (c.isCheckmate()) return { over: true, result: "checkmate", winner: otherColor(c.turn()) };
  if (c.isStalemate()) return { over: true, result: "stalemate", winner: null };
  if (c.reps ? Object.values(c.reps).some((n) => n >= 3) : c.isThreefoldRepetition()) return { over: true, result: "draw by repetition", winner: null };
  if (c.isInsufficientMaterial()) return { over: true, result: "draw by insufficient material", winner: null };
  if (c.isDraw()) return { over: true, result: "draw by the fifty-move rule", winner: null };
  if (plies(c) >= MAX_PLIES) return { over: true, result: `draw by the ${MAX_PLIES}-ply limit`, winner: null };
  return { over: false, result: null, winner: null };
}

// Every `color` piece bearing on `square`: values cheapest first with the king (0) last, plus the cheapest
// non-king attacker's type. One board scan per side.
function bearing(c, square, color) {
  const values = [];
  let attacker = null, cheapest = null;
  for (const sq of c.attackers(square, color)) {
    const p = c.get(sq);
    if (!p) continue;
    values.push(VALUE[p.type]);
    if (p.type !== "k" && (cheapest === null || VALUE[p.type] < cheapest)) { cheapest = VALUE[p.type]; attacker = p.type; }
  }
  values.sort((x, y) => (x === 0 ? 1 : y === 0 ? -1 : x - y));
  return { values, attacker, king: values.length > 0 && values[values.length - 1] === 0 };
}
// Material a `me` piece worth `val` on `square` is likely to lose: a static exchange over every attacker
// and defender, cheapest piece first. A king may only take once nothing defends the square any more.
// One recapture is not enough to call a piece safe: two attackers against one defender win it outright.
// Pinned pieces are counted as if free to move (known approximation).
// What the side to move wins by capturing a piece worth `target` with attackers `att` against defenders `def`
// (both cheapest first, king = 0 last). The capturer may decline, so the result is never negative.
function see(target, att, def) {
  if (!att.length) return 0;
  if (att[0] === 0 && def.length) return 0;            // a king cannot capture a defended piece
  return Math.max(0, target - see(att[0], def, att.slice(1)));
}
function riskOn(c, square, val, me) {
  const att = bearing(c, square, otherColor(me));
  if (!att.values.length) return { risk: 0, attacker: null, defended: false };
  const def = bearing(c, square, me);
  if (!def.values.length) return { risk: val, attacker: att.attacker ?? "k", defended: false };
  const risk = see(val, att.values, def.values);
  return { risk, attacker: risk > 0 ? att.attacker ?? "k" : null, defended: true };
}
// After a move by `me`: the worst hanging `me` piece other than the one on `skip` (one-ply opponent reply).
function worstHanging(c, me, skip) {
  let worst = 0, what = null;
  for (const rank of c.board()) for (const sq of rank) {
    if (!sq || sq.color !== me || sq.type === "k" || sq.square === skip) continue;
    const r = riskOn(c, sq.square, VALUE[sq.type], me);
    if (r.risk > worst) { worst = r.risk; what = sq; }
  }
  return { worst, what };
}
const HOME_RANK = { w: "1", b: "8" };
const CENTER = new Set(["d4", "e4", "d5", "e5"]);

// Annotate one legal move. `c` is mutated and restored. `deep` adds the scan for other pieces left
// en prise (a full board scan, so analyzeAll only does it for the leading moves).
export function analyzeMove(c, m, deep = true) {
  const me = m.color;
  const captured = (m.captured ? VALUE[m.captured] : 0) + (m.promotion ? VALUE[m.promotion] - 1 : 0);
  const moverVal = VALUE[m.promotion || m.piece];
  c.move(m.san);
  const check = c.inCheck();
  const mate = c.isCheckmate();
  const stalemate = c.isStalemate();
  const self = mate ? { risk: 0, attacker: null } : riskOn(c, m.to, moverVal, me);
  const other = !deep || mate || stalemate ? { worst: 0, what: null } : worstHanging(c, me, m.to);
  c.undo();
  const gain = captured - self.risk;
  const castles = m.flags.includes("k") ? "kingside" : m.flags.includes("q") ? "queenside" : null;
  const develops = (m.piece === "n" || m.piece === "b") && m.from[1] === HOME_RANK[me];
  let score = gain - 0.9 * other.worst + (mate ? 1000 : 0) + (check ? 0.4 : 0) + (castles ? 0.8 : 0) + (develops ? 0.5 : 0) + (CENTER.has(m.to) ? 0.3 : 0);
  if (stalemate) score -= 50;
  if (m.piece === "k" && !castles) score -= 0.5;
  const parts = [];
  if (mate) parts.push("checkmate");
  if (m.captured) parts.push(`captures a ${NAME[m.captured]} (${VALUE[m.captured]})${self.risk === 0 ? " for free" : ""}`);
  if (m.promotion) parts.push(`promotes to a ${NAME[m.promotion]}`);
  if (castles) parts.push(`castles ${castles}`);
  if (check && !mate) parts.push("gives check");
  if (self.risk > 0) {
    const mover = NAME[m.promotion || m.piece];
    parts.push(!self.defended ? `hangs the ${mover} (${self.risk}): attacked by a ${NAME[self.attacker]}, undefended`
      : self.risk === moverVal ? `hangs the ${mover} (${self.risk}): attacked by a ${NAME[self.attacker]}, more attackers than defenders`
      : `${mover} can be taken by a ${NAME[self.attacker]} (loses ${self.risk})`);
  }
  if (develops) parts.push(`develops a ${NAME[m.piece]}`);
  if (other.worst > 0) parts.push(`leaves the ${NAME[other.what.type]} on ${other.what.square} en prise (-${other.worst})`);
  if (stalemate) parts.push("stalemates the opponent (draw)");
  if (!parts.length) parts.push("quiet move");
  return { key: m.san, from: m.from, to: m.to, piece: m.piece, captured: m.captured || null, promotion: m.promotion || null,
    gain, oppBest: other.worst, mate, check, castles, develops, hangs: self.risk > 0, stalemate, score, desc: parts.join("; ") };
}

// What a move threatens: the worst opponent piece left attacked and under-defended after it.
function addThreat(c, a) {
  c.move(a.key);
  const t = worstHanging(c, C_other(a), a.to);
  c.undo();
  if (t.worst > 0 && !a.mate) {
    a.threatens = t.worst;
    a.score += 0.3 * t.worst;
    a.desc = a.desc.replace(/^quiet move$/, "") + (a.desc === "quiet move" ? "" : "; ") + `threatens the ${NAME[t.what.type]} on ${t.what.square} (+${t.worst})`;
    a.desc = a.desc.replace(/^; /, "");
  }
  return a;
}
const C_other = (a) => (a.piece && a.from ? otherColor(a.color) : "b");

// All legal moves annotated and ranked (best first). Threat annotations are computed for the top 16 only
// (they cost a second board scan), then the ranking is refreshed. `c` is restored.
export function analyzeAll(c, deepCount = 16) {
  const moves = c.moves({ verbose: true });
  let out = moves.map((m) => Object.assign(analyzeMove(c, m, false), { color: m.color, m }));
  out.sort((a, b) => b.score - a.score);
  // Second pass for the leading moves: what else they leave en prise, and what they threaten.
  const lead = out.slice(0, deepCount).map((a) => addThreat(c, Object.assign(analyzeMove(c, a.m, true), { color: a.color })));
  out = lead.concat(out.slice(deepCount).map(({ m, ...rest }) => rest));
  out.sort((a, b) => b.score - a.score);
  return out;
}
export const truthOf = (analyses) => ({
  mate: analyses.filter((a) => a.mate).map((a) => a.key),
  material: analyses.filter((a) => a.captured && a.gain > 0).map((a) => a.key),
});
export const slimLegal = (c) => c.moves({ verbose: true }).map((m) => ({ san: m.san, from: m.from, to: m.to, promotion: m.promotion || null }));
