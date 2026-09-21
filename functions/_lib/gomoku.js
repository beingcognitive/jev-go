// Pure Gomoku logic shared by the serverless function and the tests.
// Board: 15x15 array of arrays, chars "X" | "O" | ".". Row 0 is printed row 15 (top).

export const SIZE = 15;
export const COLS = "ABCDEFGHIJKLMNO";
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

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

export function toRows(board) {
  return board.map((r) => r.join(""));
}

export function inBounds(r, c) {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

export function key(r, c) {
  return `${COLS[c]}${SIZE - r}`;
}

export function fromKey(k) {
  const m = /^([A-O])(\d{1,2})$/.exec(String(k || ""));
  if (!m) return null;
  const c = COLS.indexOf(m[1]);
  const row = Number(m[2]);
  if (row < 1 || row > SIZE) return null;
  return { r: SIZE - row, c };
}

export function emptyPoints(board) {
  const pts = [];
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++)
      if (board[r][c] === ".") pts.push({ r, c, key: key(r, c) });
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

function run(board, r, c, color, dr, dc) {
  let n = 0, rr = r + dr, cc = c + dc;
  while (inBounds(rr, cc) && board[rr][cc] === color) { n++; rr += dr; cc += dc; }
  return { n, endOpen: inBounds(rr, cc) && board[rr][cc] === "." };
}

// For each of the 4 directions: the line length if `color` sits at (r,c), and whether both ends are empty.
export function lineInfo(board, r, c, color) {
  return DIRS.map(([dr, dc]) => {
    const a = run(board, r, c, color, dr, dc);
    const b = run(board, r, c, color, -dr, -dc);
    return { len: a.n + b.n + 1, open: a.endOpen && b.endOpen };
  });
}

export const makesFive = (b, r, c, col) => lineInfo(b, r, c, col).some((l) => l.len >= 5);
export const makesOpenFour = (b, r, c, col) => lineInfo(b, r, c, col).some((l) => l.len === 4 && l.open);
export const makesOpenThree = (b, r, c, col) => lineInfo(b, r, c, col).some((l) => l.len === 3 && l.open);

export function isWinAt(board, r, c) {
  const color = board[r][c];
  if (color === ".") return false;
  return makesFive(board, r, c, color);
}

// Ground truth for the two threat questions.
//  win:   empty points where `me` makes five (or more) now.
//  block: empty points where `opp` would make five, or an open four, on its next move.
export function threatSets(board, me, opp) {
  const pts = emptyPoints(board);
  const win = pts.filter((p) => makesFive(board, p.r, p.c, me)).map((p) => p.key);
  const block = pts
    .filter((p) => makesFive(board, p.r, p.c, opp) || makesOpenFour(board, p.r, p.c, opp))
    .map((p) => p.key);
  return { win, block };
}

function adjacentToStone(board, r, c) {
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (inBounds(rr, cc) && board[rr][cc] !== ".") return true;
    }
  return false;
}

// "Assisted" option description: code-computed line facts, so Jev reads labels instead of the grid.
export function describe(board, r, c, me, opp) {
  const parts = [];
  const mine = lineInfo(board, r, c, me);
  const mMax = Math.max(...mine.map((l) => l.len));
  const mOpen = mine.some((l) => l.len === mMax && l.open);
  if (mMax >= 5) parts.push(`${me} makes five and wins`);
  else if (mMax === 4) parts.push(`${me} makes ${mOpen ? "an open" : "a closed"} four`);
  else if (mMax === 3) parts.push(`${me} makes ${mOpen ? "an open" : "a closed"} three`);
  else if (mMax === 2) parts.push(`${me} makes two`);

  const theirs = lineInfo(board, r, c, opp);
  const oMax = Math.max(...theirs.map((l) => l.len));
  const oOpen = theirs.some((l) => l.len === oMax && l.open);
  if (oMax >= 5) parts.push(`blocks ${opp} from making five`);
  else if (oMax === 4) parts.push(`blocks ${opp}'s ${oOpen ? "open" : "closed"} four`);
  else if (oMax === 3) parts.push(`blocks ${opp}'s ${oOpen ? "open" : "closed"} three`);

  if (!parts.length) parts.push(adjacentToStone(board, r, c) ? "next to existing stones" : "far from all stones");
  return parts.join("; ");
}

export function render(board) {
  const lines = ["   " + COLS.split("").join(" ")];
  for (let r = 0; r < SIZE; r++) lines.push(String(SIZE - r).padStart(2, " ") + " " + board[r].join(" "));
  return lines.join("\n");
}

// TypeSafe's documented shape-based confidence, generalised to N options: (N*pmax - 1) / (N - 1).
export function confidenceFrom(probs) {
  const vals = Object.values(probs || {}).map(Number).filter((v) => !Number.isNaN(v));
  const n = vals.length;
  if (n < 2) return 1;
  const pmax = Math.max(...vals);
  return Math.max(0, Math.min(1, (n * pmax - 1) / (n - 1)));
}

export function topK(probs, k = 5) {
  return Object.entries(probs || {})
    .map(([key, p]) => [key, Number(p)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, k);
}

export function argmax(probs) {
  return topK(probs, 1)[0]?.[0] ?? null;
}
