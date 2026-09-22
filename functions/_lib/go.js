// 9x9 Go engine: groups, captures, suicide, positional superko, area scoring, move annotations.
// Board: array of arrays, "X" black, "O" white, "." empty. Row 0 is printed row 9 (top).

export const SIZE = 9;
export const COLS = "ABCDEFGHJ"; // Go convention: no I
export const KOMI = 7.5;
export const MAX_MOVES = 200;

export const emptyBoard = () => Array.from({ length: SIZE }, () => Array(SIZE).fill("."));
export const copy = (b) => b.map((r) => r.slice());
export const toRows = (b) => b.map((r) => r.join(""));
export const hash = (b) => toRows(b).join("/");
export const inBounds = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
export const key = (r, c) => `${COLS[c]}${SIZE - r}`;
export const other = (c) => (c === "X" ? "O" : "X");
export function fromKey(k) {
  const m = /^([A-J])([1-9])$/.exec(String(k || ""));
  if (!m) return null;
  const c = COLS.indexOf(m[1]);
  if (c < 0) return null;
  return { r: SIZE - Number(m[2]), c };
}
const N4 = (r, c) => [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].filter(([a, b]) => inBounds(a, b));
export const MOVE_RE = /^([XO]) (pass|[A-J][1-9])$/;

export function render(board) {
  const lines = ["  " + COLS.split("").join(" ")];
  for (let r = 0; r < SIZE; r++) lines.push(String(SIZE - r) + " " + board[r].join(" "));
  return lines.join("\n");
}

export function group(board, r, c) {
  const color = board[r][c];
  if (color === ".") return null;
  const stones = [], liberties = new Set(), seen = new Set([r * SIZE + c]), stack = [[r, c]];
  while (stack.length) {
    const [a, b] = stack.pop();
    stones.push([a, b]);
    for (const [x, y] of N4(a, b)) {
      const v = board[x][y], id = x * SIZE + y;
      if (v === ".") liberties.add(id);
      else if (v === color && !seen.has(id)) { seen.add(id); stack.push([x, y]); }
    }
  }
  return { color, stones, liberties };
}

// Try a move without mutating `board`. Returns { board, captured, capturedKeys } or { error }.
export function tryMove(board, r, c, color, history) {
  if (!inBounds(r, c)) return { error: "off board" };
  if (board[r][c] !== ".") return { error: "occupied" };
  const b = copy(board);
  b[r][c] = color;
  const opp = other(color);
  let captured = 0;
  const capturedKeys = [], seen = new Set();
  for (const [x, y] of N4(r, c)) {
    if (b[x][y] !== opp || seen.has(x * SIZE + y)) continue;
    const g = group(b, x, y);
    for (const [a, bb] of g.stones) seen.add(a * SIZE + bb);
    if (g.liberties.size === 0) {
      for (const [a, bb] of g.stones) { b[a][bb] = "."; capturedKeys.push(key(a, bb)); }
      captured += g.stones.length;
    }
  }
  if (group(b, r, c).liberties.size === 0) return { error: "suicide" };
  if (history && history.has(hash(b))) return { error: captured === 1 ? "ko" : "superko" };
  return { board: b, captured, capturedKeys };
}

export const initialState = () => {
  const board = emptyBoard();
  return { board, history: new Set([hash(board)]), captures: { X: 0, O: 0 }, passes: 0, toMove: "X", last: null, count: 0 };
};

// Apply one move ("X D4" | "O pass") to a state, validating it. Returns a new state; `history` is shared and extended.
export function applyMove(st, moveStr) {
  if (st.passes >= 2 || st.count >= MAX_MOVES) throw new Error("game is over");
  const m = MOVE_RE.exec(moveStr || "");
  if (!m) throw new Error(`bad move ${st.count}: ${String(moveStr).slice(0, 12)}`);
  if (m[1] !== st.toMove) throw new Error(`move ${st.count} out of turn`);
  let board = st.board, captured = 0, passes = st.passes + 1;
  if (m[2] !== "pass") {
    const p = fromKey(m[2]);
    if (!p) throw new Error(`bad point ${m[2]}`);
    const t = tryMove(st.board, p.r, p.c, m[1], st.history);
    if (t.error) throw new Error(`move ${st.count} ${m[2]} illegal: ${t.error}`);
    board = t.board; captured = t.captured; passes = 0;
  }
  st.history.add(hash(board));
  const captures = { ...st.captures, [m[1]]: st.captures[m[1]] + captured };
  return { board, history: st.history, captures, passes, toMove: other(m[1]), last: m[2], count: st.count + 1 };
}

// Replay a move list from the empty board, validating every move. Positional superko.
export function replay(moves) {
  if (!Array.isArray(moves)) throw new Error("moves must be an array");
  if (moves.length > MAX_MOVES) throw new Error(`too many moves (max ${MAX_MOVES})`);
  let st = initialState();
  for (const mv of moves) st = applyMove(st, mv);
  return st;
}

// Area scoring. Empty regions bordered by a single color count for that color. Dead stones are not removed.
export function score(board) {
  const stones = { X: 0, O: 0 }, terr = { X: 0, O: 0 };
  const seen = new Set();
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const v = board[r][c];
    if (v !== ".") { stones[v]++; continue; }
    const id = r * SIZE + c;
    if (seen.has(id)) continue;
    const region = [], borders = new Set(), stack = [[r, c]];
    seen.add(id);
    while (stack.length) {
      const [a, b] = stack.pop();
      region.push([a, b]);
      for (const [x, y] of N4(a, b)) {
        const w = board[x][y], j = x * SIZE + y;
        if (w === ".") { if (!seen.has(j)) { seen.add(j); stack.push([x, y]); } }
        else borders.add(w);
      }
    }
    if (borders.size === 1) terr[[...borders][0]] += region.length;
  }
  const black = stones.X + terr.X, white = stones.O + terr.O + KOMI;
  return { black, white, komi: KOMI, stones, territory: terr, winner: black > white ? "X" : "O", margin: Math.abs(black - white) };
}

// ---------- move annotations ----------

const ordinal = (n) => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;
const LINE_BONUS = { 1: -4, 2: -1, 3: 2, 4: 2, 5: 1 };

// A greedy chase read for the group holding (r,c), `opp` to move: the attacker fills the liberty that leaves the
// group fewest liberties, the defender extends (or captures an adjacent attacker in atari) for the most, until the
// group has four liberties ("escaped"), is captured, or the read runs out ("unclear"). Ladders and simple nets
// resolve within a few moves; anything subtler is left unclear. Boards are copied by tryMove; nothing is mutated.
export function chase(board, r, c, me, opp, maxIter = 16) {
  let b = board;
  for (let i = 0; i < maxIter; i++) {
    const g = group(b, r, c);
    if (g.liberties.size >= 4) return "escaped";
    if (g.liberties.size <= 1) return "captured";
    let best = null, bestLibs = Infinity;
    for (const id of g.liberties) {
      const t = tryMove(b, Math.floor(id / SIZE), id % SIZE, opp, null);
      if (t.error) continue;
      const libs = t.board[r][c] === me ? group(t.board, r, c).liberties.size : 0;
      if (libs < bestLibs) { bestLibs = libs; best = t.board; }
    }
    if (!best) return "escaped";
    if (bestLibs === 0) return "captured";
    b = best;
    const g2 = group(b, r, c);
    if (g2.liberties.size >= 4) return "escaped";
    const tries = new Set(g2.liberties);
    for (const [x, y] of g2.stones) for (const [nx, ny] of N4(x, y)) {
      if (b[nx][ny] !== opp) continue;
      const og = group(b, nx, ny);
      if (og.liberties.size === 1) for (const id of og.liberties) tries.add(id);
    }
    let bestD = null, bestDL = -1;
    for (const id of tries) {
      const t = tryMove(b, Math.floor(id / SIZE), id % SIZE, me, null);
      if (t.error || t.board[r][c] !== me) continue;
      const libs = group(t.board, r, c).liberties.size;
      if (libs > bestDL) { bestDL = libs; bestD = t.board; }
    }
    if (bestDL <= 1) return "captured";
    if (bestDL >= 4) return "escaped";
    b = bestD;
  }
  return "unclear";
}

export function analyzeMove(board, r, c, me, opp, history, lastKey) {
  const t = tryMove(board, r, c, me, history);
  if (t.error) return null;
  const after = t.board;
  // own neighbouring groups before the move
  const ownBefore = [], seenOwn = new Set();
  const oppAdj = [], seenOpp = new Set();
  let ownNeighbors = 0, oppNeighbors = 0, emptyNeighbors = 0;
  for (const [x, y] of N4(r, c)) {
    const v = board[x][y], id = x * SIZE + y;
    if (v === me) { ownNeighbors++; if (!seenOwn.has(id)) { const g = group(board, x, y); for (const [a, b] of g.stones) seenOwn.add(a * SIZE + b); ownBefore.push(g); } }
    else if (v === opp) { oppNeighbors++; if (!seenOpp.has(id)) { const g = group(board, x, y); for (const [a, b] of g.stones) seenOpp.add(a * SIZE + b); oppAdj.push(g); } }
    else emptyNeighbors++;
  }
  const own = group(after, r, c);
  const libsAfter = own.liberties.size;
  // Every own group short of liberties (one or two) before the move, including ones helped by capturing the
  // attacker, which need not touch (r,c): saved (out of atari, and the chase read does not capture it), doomed
  // (out of atari only into a losing chase), or rescued (from two liberties to three or more). Groups left short
  // are listed once in the state, not on every option.
  let saved = 0, doomed = 0, rescued = 0;
  const seenSaved = new Set();
  for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) {
    if (board[x][y] !== me || seenSaved.has(x * SIZE + y)) continue;
    const g = group(board, x, y);
    for (const [a, b] of g.stones) seenSaved.add(a * SIZE + b);
    if (g.liberties.size > 2) continue;
    const [a, b] = g.stones[0];
    if (after[a][b] !== me) continue;
    const libs = group(after, a, b).liberties.size;
    if (g.liberties.size === 1 && libs >= 2) { if (libs === 2 && chase(after, a, b, me, opp) === "captured") doomed += g.stones.length; else saved += g.stones.length; }
    else if (g.liberties.size === 2 && libs >= 3) rescued += g.stones.length;
  }
  let atari = 0, atariGroups = 0;
  const seenAfter = new Set();
  for (const [x, y] of N4(r, c)) {
    if (after[x][y] !== opp || seenAfter.has(x * SIZE + y)) continue;
    const g = group(after, x, y);
    for (const [a, b] of g.stones) seenAfter.add(a * SIZE + b);
    if (g.liberties.size === 1) { atari += g.stones.length; atariGroups++; }
  }
  const selfAtari = libsAfter === 1 && own.stones.length > t.captured; // a capture bigger than the group is a trade; smaller, it is a snapback
  const connects = ownBefore.length >= 2 ? ownBefore.length : 0;
  const neighborsInBounds = N4(r, c).length;
  const eyeFill = ownNeighbors === neighborsInBounds && t.captured === 0;
  const line = Math.min(r, c, SIZE - 1 - r, SIZE - 1 - c) + 1;
  const lp = lastKey ? fromKey(lastKey) : null;
  const nearLast = !!(lp && Math.max(Math.abs(lp.r - r), Math.abs(lp.c - c)) <= 1);
  let scoreV = t.captured * 12 + saved * 10 + rescued * 4 - doomed * 2 + atari * 4 + connects * 2 + Math.min(libsAfter, 4) + (LINE_BONUS[line] || 0) + oppNeighbors * 0.5 + (nearLast ? 1 : 0);
  if (selfAtari) scoreV -= 10 + 5 * Math.min(own.stones.length, 8);
  if (eyeFill) scoreV -= 25;
  const parts = [];
  if (t.captured) parts.push(`captures ${t.captured} ${opp} stone${t.captured > 1 ? "s" : ""}`);
  if (saved) parts.push(`saves ${saved} ${me} stone${saved > 1 ? "s" : ""} from atari`);
  if (doomed) parts.push(`cannot save the ${doomed} ${me} stone${doomed > 1 ? "s" : ""} in atari: ${opp} captures ${doomed > 1 ? "them" : "it"} in the chase`);
  if (rescued) parts.push(`gives ${rescued} ${me} stone${rescued > 1 ? "s" : ""} a third liberty (they were one move from atari)`);
  if (atari) parts.push(`puts ${atari} ${opp} stone${atari > 1 ? "s" : ""} in atari`);
  if (connects) parts.push(`connects ${connects} ${me} groups`);
  if (selfAtari) parts.push(`self-atari (${own.stones.length} stone${own.stones.length > 1 ? "s" : ""} left with one liberty${t.captured ? ", so the capture can be taken straight back" : ""})`);
  if (eyeFill) parts.push(`fills own eye`);
  parts.push(`${ordinal(line)} line`);
  parts.push(`${libsAfter} libert${libsAfter === 1 ? "y" : "ies"} after`);
  if (oppNeighbors) parts.push(`touches ${oppNeighbors} ${opp} stone${oppNeighbors > 1 ? "s" : ""}`);
  return { key: key(r, c), r, c, captured: t.captured, capturedKeys: t.capturedKeys, saved, doomed, rescued, atari, atariGroups, connects, selfAtari, eyeFill, line, libsAfter, oppNeighbors, nearLast, score: scoreV, desc: parts.join("; ") };
}

// The pass option always carries the count as it stands, because passing can end the game on it.
export const PASS_DESC = (opp, board, me) => {
  const s = board ? score(board) : null;
  const now = s ? ` Counted right now: black ${s.black}, white ${s.white} (komi ${KOMI} included), so ${s.winner === me ? "you would win" : "you would LOSE"} by ${s.margin}.` : "";
  return `pass. If ${opp} also passes, the game ends and is scored by area (Chinese rules, komi ${KOMI}).${now} Dead stones are not removed, so capture them first.`;
};

// All legal moves analyzed and ranked (best first).
export function analyzeAll(board, me, opp, history, lastKey) {
  const out = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    if (board[r][c] !== ".") continue;
    const a = analyzeMove(board, r, c, me, opp, history, lastKey);
    if (a) out.push(a);
  }
  out.sort((x, y) => y.score - x.score);
  return out;
}
