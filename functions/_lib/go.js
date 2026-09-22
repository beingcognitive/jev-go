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

// After a stone was placed at (r,c): the separate empty regions its empty neighbours now belong to, and how many of
// them are bordered only by the stone's own group (an eye of that group; a region touching another of our groups
// may be a false eye, as when that group can be captured through it).
function splitInfo(board, r, c) {
  const own = new Set(group(board, r, c).stones.map(([a, b]) => a * SIZE + b));
  const seen = new Set();
  let regions = 0, eyes = 0;
  for (const [x, y] of N4(r, c)) {
    if (board[x][y] !== "." || seen.has(x * SIZE + y)) continue;
    regions++;
    let mine = true;
    const stack = [[x, y]]; seen.add(x * SIZE + y);
    while (stack.length) {
      const [a, b] = stack.pop();
      for (const [p, q] of N4(a, b)) {
        const j = p * SIZE + q;
        if (board[p][q] === ".") { if (!seen.has(j)) { seen.add(j); stack.push([p, q]); } }
        else if (!own.has(j)) mine = false;
      }
    }
    if (mine) eyes++;
  }
  return { regions, eyes };
}
// The colour that alone borders the empty region holding (r,c), or null.
function regionOwner(board, r, c) {
  const seen = new Set([r * SIZE + c]), stack = [[r, c]], borders = new Set();
  while (stack.length) {
    const [a, b] = stack.pop();
    for (const [x, y] of N4(a, b)) {
      const w = board[x][y], j = x * SIZE + y;
      if (w === ".") { if (!seen.has(j)) { seen.add(j); stack.push([x, y]); } }
      else borders.add(w);
    }
  }
  return borders.size === 1 ? [...borders][0] : null;
}

// ---------- move annotations ----------

const ordinal = (n) => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;
const LINE_BONUS = { 1: -4, 2: -1, 3: 2, 4: 2, 5: 1 };

// A ladder read for the two-liberty group holding (r,c), `opp` to move: can `opp` capture it by ataris alone?
// The attacker tries both liberties; the defender tries every answer (extend, or capture an adjacent attacker in
// atari); a line where the defender reaches three liberties escapes. Legal moves only, ko and superko included:
// `history` is extended along each line and restored. Returns "captured", "escaped", or "unclear" when the read
// runs past `budget` positions. Nets and other non-atari captures are not read. Boards are copied by tryMove.
export function chase(board, r, c, me, opp, history = null, budget = 250) {
  const hist = new Set(history || []);
  let nodes = 0;
  const attack = (b, depth) => { // opp to move; the group has two liberties
    if (++nodes > budget || depth > 30) throw chase;
    const g0 = group(b, r, c);
    for (const id of g0.liberties) {
      const t = tryMove(b, Math.floor(id / SIZE), id % SIZE, opp, hist);
      if (t.error || t.board[r][c] !== me) continue;
      if (group(t.board, r, c).liberties.size !== 1) continue; // not an atari
      hist.add(hash(t.board));
      try { if (!defend(t.board, depth + 1)) return true; } finally { hist.delete(hash(t.board)); }
    }
    return false;
  };
  const defend = (b, depth) => { // me to move; the group is in atari. True when some answer holds.
    if (++nodes > budget) throw chase;
    const g1 = group(b, r, c), tries = new Set(g1.liberties);
    for (const [x, y] of g1.stones) for (const [nx, ny] of N4(x, y)) {
      if (b[nx][ny] !== opp) continue;
      const og = group(b, nx, ny);
      if (og.liberties.size === 1) for (const id of og.liberties) tries.add(id);
    }
    for (const id of tries) {
      const t = tryMove(b, Math.floor(id / SIZE), id % SIZE, me, hist);
      if (t.error || t.board[r][c] !== me) continue;
      const libs = group(t.board, r, c).liberties.size;
      if (libs >= 3) return true;
      if (libs <= 1) continue;
      hist.add(hash(t.board));
      try { if (!attack(t.board, depth + 1)) return true; } finally { hist.delete(hash(t.board)); }
    }
    return false;
  };
  try {
    const libs = group(board, r, c).liberties.size;
    if (libs >= 3) return "escaped";
    if (libs <= 1) return "captured";
    return attack(board, 0) ? "captured" : "escaped";
  } catch (e) { if (e === chase) return "unclear"; throw e; }
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
  const histAfter = history ? new Set([...history, hash(after)]) : null;
  // Every own group short of liberties (one or two) before the move, including ones helped by capturing the
  // attacker, which need not touch (r,c): saved (out of atari to three liberties, or to two and the ladder read
  // says it escapes), doomed (out of atari only into a ladder that captures it), running (out of atari to two
  // liberties, the read unsettled), or rescued (from two liberties to three or more). Groups left short are listed
  // once in the state, not on every option.
  let saved = 0, doomed = 0, running = 0, rescued = 0;
  const seenSaved = new Set();
  for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) {
    if (board[x][y] !== me || seenSaved.has(x * SIZE + y)) continue;
    const g = group(board, x, y);
    for (const [a, b] of g.stones) seenSaved.add(a * SIZE + b);
    if (g.liberties.size > 2) continue;
    const [a, b] = g.stones[0];
    if (after[a][b] !== me) continue;
    const libs = group(after, a, b).liberties.size;
    if (g.liberties.size === 1 && libs >= 2) {
      const read = libs === 2 ? chase(after, a, b, me, opp, histAfter) : "escaped";
      if (read === "captured") doomed += g.stones.length; else if (read === "unclear") running += g.stones.length; else saved += g.stones.length;
    }
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
  // In atari after the move: a self-atari, unless it captured and the opponent cannot legally take back (ko)
  let selfAtari = libsAfter === 1;
  if (selfAtari && t.captured) { const l = [...own.liberties][0]; selfAtari = !tryMove(after, Math.floor(l / SIZE), l % SIZE, opp, histAfter).error; }
  const connects = ownBefore.length >= 2 ? ownBefore.length : 0;
  const neighborsInBounds = N4(r, c).length;
  const eyeFill = ownNeighbors === neighborsInBounds && t.captured === 0;
  // Inside our own eye space (the empty region holding (r,c) borders only our stones, nothing captured): does the
  // move divide it into two or more eyes, or only fill it? A straight three is alive with its middle point played.
  const ownEye = !t.captured && oppNeighbors === 0 && regionOwner(board, r, c) === me;
  const split = ownEye ? splitInfo(after, r, c) : { regions: 0, eyes: 0 };
  const line = Math.min(r, c, SIZE - 1 - r, SIZE - 1 - c) + 1;
  const lp = lastKey ? fromKey(lastKey) : null;
  const nearLast = !!(lp && Math.max(Math.abs(lp.r - r), Math.abs(lp.c - c)) <= 1);
  let scoreV = t.captured * 12 + saved * 10 + running * 4 + rescued * 4 - doomed * 2 + atari * 4 + connects * 2 + Math.min(libsAfter, 4) + (LINE_BONUS[line] || 0) + oppNeighbors * 0.5 + (nearLast ? 1 : 0);
  if (selfAtari) scoreV -= 10 + 5 * own.stones.length + atari * 4; // the opponent moves first: our atari counts for nothing
  if (ownEye && !eyeFill) scoreV += split.eyes >= 2 ? 6 : split.regions >= 2 ? 0 : -3;
  if (eyeFill) scoreV -= 25;
  const parts = [];
  if (t.captured) parts.push(`captures ${t.captured} ${opp} stone${t.captured > 1 ? "s" : ""}`);
  if (saved) parts.push(`saves ${saved} ${me} stone${saved > 1 ? "s" : ""} from atari`);
  if (doomed) parts.push(`cannot save the ${doomed} ${me} stone${doomed > 1 ? "s" : ""} in atari: ${opp} captures ${doomed > 1 ? "them" : "it"} in the chase`);
  if (running) parts.push(`takes ${running} ${me} stone${running > 1 ? "s" : ""} out of atari into a chase the read cannot settle (2 liberties)`);
  if (rescued) parts.push(`gives ${rescued} ${me} stone${rescued > 1 ? "s" : ""} a third liberty (they were one move from atari)`);
  if (atari) parts.push(`puts ${atari} ${opp} stone${atari > 1 ? "s" : ""} in atari`);
  if (connects) parts.push(`connects ${connects} ${me} groups`);
  if (selfAtari) parts.push(`self-atari (${own.stones.length} stone${own.stones.length > 1 ? "s" : ""} left with one liberty${t.captured ? ", so the capture can be taken straight back" : ""})`);
  if (eyeFill) parts.push(`fills own eye`);
  else if (ownEye) parts.push(split.eyes >= 2 ? `divides own eye space into ${split.eyes} eyes of this group` : split.regions >= 2 ? `separates own eye space into ${split.regions} regions (not all of them eyes of this group)` : `fills own eye space`);
  parts.push(`${ordinal(line)} line`);
  parts.push(`${libsAfter} libert${libsAfter === 1 ? "y" : "ies"} after`);
  if (oppNeighbors) parts.push(`touches ${oppNeighbors} ${opp} stone${oppNeighbors > 1 ? "s" : ""}`);
  return { key: key(r, c), r, c, captured: t.captured, capturedKeys: t.capturedKeys, saved, doomed, running, rescued, ownEye, atari, atariGroups, connects, selfAtari, eyeFill, line, libsAfter, oppNeighbors, nearLast, score: scoreV, desc: parts.join("; ") };
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
