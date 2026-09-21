// Gomoku engine shared by the Pages Function, the dev server and the tests.
// Board: 15x15 array of arrays, chars "X" | "O" | ".". Row 0 is printed row 15 (top).

export const SIZE = 15;
export const COLS = "ABCDEFGHIJKLMNO";
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
export const DIR_NAMES = ["horizontal", "vertical", "diagonal", "anti-diagonal"];

export function emptyBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill("."));
}
export function parseBoard(rows) {
  if (!Array.isArray(rows) || rows.length !== SIZE) throw new Error(`board must have ${SIZE} rows`);
  return rows.map((row, i) => {
    if (typeof row !== "string" || row.length !== SIZE || /[^XO.]/.test(row)) throw new Error(`bad board row ${i}`);
    return row.split("");
  });
}
export const toRows = (board) => board.map((r) => r.join(""));
export const inBounds = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
export const key = (r, c) => `${COLS[c]}${SIZE - r}`;
export function fromKey(k) {
  const m = /^([A-O])(\d{1,2})$/.exec(String(k || ""));
  if (!m) return null;
  const row = Number(m[2]);
  if (row < 1 || row > SIZE) return null;
  return { r: SIZE - row, c: COLS.indexOf(m[1]) };
}
export function emptyPoints(board) {
  const pts = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (board[r][c] === ".") pts.push({ r, c, key: key(r, c) });
  return pts;
}
export function counts(board) {
  let X = 0, O = 0;
  for (const row of board) for (const ch of row) { if (ch === "X") X++; else if (ch === "O") O++; }
  return { X, O };
}
export function toMove(board) {
  const { X, O } = counts(board);
  return X === O ? "X" : "O";
}
export function render(board) {
  const lines = ["   " + COLS.split("").join(" ")];
  for (let r = 0; r < SIZE; r++) lines.push(String(SIZE - r).padStart(2, " ") + " " + board[r].join(" "));
  return lines.join("\n");
}

// ---------- line primitives ----------

function run(board, r, c, color, dr, dc) {
  let n = 0, rr = r + dr, cc = c + dc;
  while (inBounds(rr, cc) && board[rr][cc] === color) { n++; rr += dr; cc += dc; }
  return { n, endOpen: inBounds(rr, cc) && board[rr][cc] === "." };
}
// Contiguous run through (r,c) along one direction, counting (r,c) itself as `color`.
export function lineLenDir(board, r, c, color, dr, dc) {
  return run(board, r, c, color, dr, dc).n + run(board, r, c, color, -dr, -dc).n + 1;
}
export function lineInfo(board, r, c, color) {
  return DIRS.map(([dr, dc]) => {
    const a = run(board, r, c, color, dr, dc), b = run(board, r, c, color, -dr, -dc);
    return { len: a.n + b.n + 1, open: a.endOpen && b.endOpen };
  });
}
export const makesFive = (b, r, c, col) => lineInfo(b, r, c, col).some((l) => l.len >= 5);
export function isWinAt(board, r, c) {
  const color = board[r][c];
  return color !== "." && makesFive(board, r, c, color);
}

// Empty cells on one line within 4 of (r,c) where placing `color` completes five along that line.
// Assumes board[r][c] === color.
function fivePointsDir(board, r, c, color, dr, dc) {
  const pts = [];
  for (let k = -4; k <= 4; k++) {
    if (k === 0) continue;
    const rr = r + k * dr, cc = c + k * dc;
    if (!inBounds(rr, cc) || board[rr][cc] !== ".") continue;
    board[rr][cc] = color;
    if (lineLenDir(board, rr, cc, color, dr, dc) >= 5) pts.push(key(rr, cc));
    board[rr][cc] = ".";
  }
  return pts;
}

// Threat that `color` at (r,c) creates along one direction. Handles split shapes:
//   five        line of five
//   open_four   two distinct points complete five (unstoppable)
//   four        exactly one point completes five (closed or split four)
//   open_three  some follow-up on this line makes an open four
//   three / open_two / two   contiguous shapes without a forcing follow-up
function dirThreat(board, r, c, color, dr, dc) {
  const len = lineLenDir(board, r, c, color, dr, dc);
  if (len >= 5) return "five";
  const fives = fivePointsDir(board, r, c, color, dr, dc);
  if (fives.length >= 2) return "open_four";
  if (fives.length === 1) return "four";
  for (let k = -4; k <= 4; k++) {
    if (k === 0) continue;
    const rr = r + k * dr, cc = c + k * dc;
    if (!inBounds(rr, cc) || board[rr][cc] !== ".") continue;
    board[rr][cc] = color;
    const n = fivePointsDir(board, rr, cc, color, dr, dc).length;
    board[rr][cc] = ".";
    if (n >= 2) return "open_three";
  }
  if (len === 3) return "three";
  if (len === 2) {
    const a = run(board, r, c, color, dr, dc), b = run(board, r, c, color, -dr, -dc);
    return a.endOpen && b.endOpen ? "open_two" : "two";
  }
  return null;
}

export const VALUE = {
  five: 1e6, open_four: 1e5, double_four: 6e4, four_three: 5e4, double_three: 2e4,
  four: 4e3, open_three: 3e3, three: 300, open_two: 250, two: 40, none: 0,
};
export const LABEL = {
  five: "five in a row", open_four: "an open four", double_four: "two fours at once",
  four_three: "a four plus an open three", double_three: "two open threes at once",
  four: "a four", open_three: "an open three", three: "a closed three",
  open_two: "an open two", two: "a two", none: null,
};

export function classify(counts) {
  const n = (k) => counts[k] || 0;
  if (n("five")) return "five";
  if (n("open_four")) return "open_four";
  if (n("four") >= 2) return "double_four";
  if (n("four") && n("open_three")) return "four_three";
  if (n("open_three") >= 2) return "double_three";
  if (n("four")) return "four";
  if (n("open_three")) return "open_three";
  if (n("three")) return "three";
  if (n("open_two")) return "open_two";
  if (n("two")) return "two";
  return "none";
}

// What `color` would create by playing (r,c). Board is restored afterwards.
export function analyzeMove(board, r, c, color) {
  board[r][c] = color;
  const dirs = DIRS.map(([dr, dc], i) => ({ name: DIR_NAMES[i], threat: dirThreat(board, r, c, color, dr, dc) }));
  board[r][c] = ".";
  const cnt = {};
  for (const d of dirs) if (d.threat) cnt[d.threat] = (cnt[d.threat] || 0) + 1;
  return { dirs, counts: cnt, cls: classify(cnt) };
}
export const makesOpenFour = (b, r, c, col) => (analyzeMove(b, r, c, col).counts.open_four || 0) > 0;
export const makesOpenThree = (b, r, c, col) => (analyzeMove(b, r, c, col).counts.open_three || 0) > 0;

// Empties where `color` completes five now.
export function fivePointsFor(board, color) {
  return emptyPoints(board).filter((p) => makesFive(board, p.r, p.c, color)).map((p) => p.key);
}
// Ground truth for the two threat questions (naked / assisted modes).
export function threatSets(board, me, opp) {
  const pts = emptyPoints(board);
  const win = pts.filter((p) => makesFive(board, p.r, p.c, me)).map((p) => p.key);
  const block = pts.filter((p) => makesFive(board, p.r, p.c, opp) || makesOpenFour(board, p.r, p.c, opp)).map((p) => p.key);
  return { win, block };
}

// ---------- candidate generation for player mode ----------

export function nearPoints(board, dist = 2) {
  const map = new Map();
  let any = false;
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    if (board[r][c] === ".") continue;
    any = true;
    for (let dr = -dist; dr <= dist; dr++) for (let dc = -dist; dc <= dist; dc++) {
      const rr = r + dr, cc = c + dc;
      if (inBounds(rr, cc) && board[rr][cc] === ".") map.set(key(rr, cc), { r: rr, c: cc, key: key(rr, cc) });
    }
  }
  if (!any) return [{ r: 7, c: 7, key: "H8" }];
  return [...map.values()];
}
function adjacency(board, r, c) {
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const rr = r + dr, cc = c + dc;
    if (inBounds(rr, cc) && board[rr][cc] !== ".") n++;
  }
  return n;
}
// After `me` plays (r,c): the worst immediate threat `opp` could then create ("five" | "open_four" | null).
export function oppThreatAfter(board, r, c, me, opp, near) {
  board[r][c] = me;
  let worst = null;
  outer: for (const q of near) {
    if (board[q.r][q.c] !== ".") continue;
    board[q.r][q.c] = opp;
    for (const [dr, dc] of DIRS) {
      if (lineLenDir(board, q.r, q.c, opp, dr, dc) >= 5) { worst = "five"; board[q.r][q.c] = "."; break outer; }
      if (fivePointsDir(board, q.r, q.c, opp, dr, dc).length >= 2) worst = "open_four";
    }
    board[q.r][q.c] = ".";
  }
  board[r][c] = ".";
  return worst;
}
const FORCING = new Set(["five", "open_four", "double_four", "four_three", "four"]);

function dirNames(a, classes) {
  const names = a.dirs.filter((d) => d.threat && classes.includes(d.threat)).map((d) => d.name);
  return names.length ? ` (${names.join(", ")})` : "";
}
function contributing(cls) {
  if (cls === "four_three") return ["four", "open_three"];
  if (cls === "double_four") return ["four"];
  if (cls === "double_three") return ["open_three"];
  return [cls];
}
export function describeCandidate(cand, me, opp) {
  const parts = [];
  if (cand.me.cls !== "none") parts.push(`${me} makes ${LABEL[cand.me.cls]}${dirNames(cand.me, contributing(cand.me.cls))}`);
  if (VALUE[cand.opp.cls] >= VALUE.three) parts.push(`blocks ${opp} from making ${LABEL[cand.opp.cls]}${dirNames(cand.opp, contributing(cand.opp.cls))}`);
  if (!parts.length) parts.push(cand.adj ? "quiet move next to stones" : "quiet move away from the stones");
  if (cand.danger === "five" && cand.me.cls !== "five") parts.push(`loses: ${opp} completes five next move`);
  else if (cand.danger === "open_four" && !cand.forcing) parts.push(`leaves ${opp} an open-four threat`);
  return parts.join("; ");
}

// Ranked candidate list for `me`. Each entry: {key, r, c, me, opp, danger, forcing, score, desc}.
export function candidates(board, me, opp, max = 12) {
  const near = nearPoints(board, 2);
  const analyzed = near.map((p) => ({ p, a: analyzeMove(board, p.r, p.c, me), b: analyzeMove(board, p.r, p.c, opp) }));
  // Adding a `me` stone can only remove `opp` options, so the opponent's threats after any of our
  // moves are a subset of its threats now. Re-test only those points.
  const oppThreats = analyzed.filter(({ b }) => b.counts.five || b.counts.open_four).map(({ p }) => p);
  const all = analyzed.map(({ p, a, b }) => {
    const danger = oppThreatAfter(board, p.r, p.c, me, opp, oppThreats);
    const forcing = FORCING.has(a.cls);
    const adj = adjacency(board, p.r, p.c);
    let score = VALUE[a.cls] + 0.9 * VALUE[b.cls] + adj * 3;
    if (danger === "five" && a.cls !== "five") score -= 1e6;
    else if (danger === "open_four" && !forcing) score -= 5e4;
    const cand = { ...p, me: a, opp: b, danger, forcing, adj, score };
    cand.desc = describeCandidate(cand, me, opp);
    return cand;
  });
  all.sort((x, y) => y.score - x.score);
  return { near, all, top: all.slice(0, max) };
}

// Assisted-mode description for any empty point (all points, not just candidates).
export function describe(board, r, c, me, opp) {
  const a = analyzeMove(board, r, c, me), b = analyzeMove(board, r, c, opp);
  const parts = [];
  if (a.cls !== "none") parts.push(`${me} makes ${LABEL[a.cls]}${dirNames(a, contributing(a.cls))}`);
  if (VALUE[b.cls] >= VALUE.three) parts.push(`blocks ${opp} from making ${LABEL[b.cls]}${dirNames(b, contributing(b.cls))}`);
  if (!parts.length) parts.push(adjacency(board, r, c) ? "next to existing stones" : "far from all stones");
  return parts.join("; ");
}

// ---------- probabilities ----------

export function confidenceFrom(probs) {
  const vals = Object.values(probs || {}).map(Number).filter((v) => !Number.isNaN(v));
  const n = vals.length;
  if (n < 2) return 1;
  const pmax = Math.max(...vals);
  return Math.max(0, Math.min(1, (n * pmax - 1) / (n - 1)));
}
export function topK(probs, k = 5) {
  return Object.entries(probs || {}).map(([k2, p]) => [k2, Number(p)]).sort((a, b) => b[1] - a[1]).slice(0, k);
}
export const argmax = (probs) => topK(probs, 1)[0]?.[0] ?? null;
