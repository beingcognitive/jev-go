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

// Empty cells on one line within 4 of (r,c) where placing `color` completes five THROUGH the stone
// at (r,c). Measuring through the probe point instead would credit shapes the stone takes no part in.
// Assumes board[r][c] === color.
function fivePointsDir(board, r, c, color, dr, dc) {
  const pts = [];
  for (let k = -4; k <= 4; k++) {
    if (k === 0) continue;
    const rr = r + k * dr, cc = c + k * dc;
    if (!inBounds(rr, cc) || board[rr][cc] !== ".") continue;
    board[rr][cc] = color;
    if (lineLenDir(board, r, c, color, dr, dc) >= 5) pts.push(key(rr, cc));
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
    const n = fivePointsDir(board, r, c, color, dr, dc).length;
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

// Work counter for the danger search's budget: one unit per point evaluated (wall-clock time is frozen on Workers).
// candidates() arms `limit`; past it the search unwinds through its finally blocks, leaving the board intact.
let work = 0, limit = Infinity;
const BUDGET = Symbol("budget");
const tick = () => { if (++work > limit) throw BUDGET; };
// What `color` would create by playing (r,c). Board is restored afterwards.
export function analyzeMove(board, r, c, color) {
  tick();
  board[r][c] = color;
  const dirs = DIRS.map(([dr, dc], i) => ({ name: DIR_NAMES[i], threat: dirThreat(board, r, c, color, dr, dc) }));
  board[r][c] = ".";
  const cnt = {};
  for (const d of dirs) if (d.threat) cnt[d.threat] = (cnt[d.threat] || 0) + 1;
  return { dirs, counts: cnt, cls: classify(cnt) };
}
export const makesOpenFour = (b, r, c, col) => (analyzeMove(b, r, c, col).counts.open_four || 0) > 0;

// Empties where `color` completes five now.
export function fivePointsFor(board, color) {
  return emptyPoints(board).filter((p) => makesFive(board, p.r, p.c, color)).map((p) => p.key);
}
// Threat classes the opponent cannot be allowed to make: a cross-direction fork is as final as an open four.
export const UNSTOPPABLE = new Set(["five", "open_four", "double_four", "four_three"]);
// Ground truth for the two threat questions (naked / assisted modes).
export function threatSets(board, me, opp) {
  const pts = emptyPoints(board);
  const win = pts.filter((p) => makesFive(board, p.r, p.c, me)).map((p) => p.key);
  const five = pts.filter((p) => makesFive(board, p.r, p.c, opp)).map((p) => p.key);
  // While `opp` can already complete five, a point that only stops a lesser threat is not a block.
  // A four-three is only unstoppable if the forced block does not counter with a winning four of its own.
  const block = five.length ? five : pts.filter((p) => {
    const cls = analyzeMove(board, p.r, p.c, opp).cls;
    if (!UNSTOPPABLE.has(cls)) return false;
    if (cls !== "four_three") return true;
    board[p.r][p.c] = opp;
    try { return forcingWinner(board, me) === opp; } finally { board[p.r][p.c] = "."; }
  }).map((p) => p.key);
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
const FORCING = new Set(["five", "open_four", "double_four", "four_three", "four"]);
// Opponent moves that have to be answered: fours and above, and open threes (a fork of threes wins unless we hold fours).
const THREAT = new Set([...FORCING, "open_three", "double_three"]);
const classAt = (board, p, color) => analyzeMove(board, p.r, p.c, color).cls;
// Forcing class of `color` at p: five, open_four, double_four, four_three, four, or none. Cheap: the open-three scan
// runs only next to a single four, where it decides four_three. Open threes alone are not this function's business.
function quickClass(board, p, color) {
  tick();
  const { r, c } = p;
  board[r][c] = color;
  let fours = 0, fourDir = -1, out = "none";
  for (const [dr, dc] of DIRS) if (lineLenDir(board, r, c, color, dr, dc) >= 5) { out = "five"; break; }
  for (let i = 0; i < 4 && out === "none"; i++) {
    const n = fivePointsDir(board, r, c, color, DIRS[i][0], DIRS[i][1]).length;
    if (n >= 2) out = "open_four"; else if (n === 1) { fours++; fourDir = i; }
  }
  if (out === "none" && fours >= 2) out = "double_four";
  else if (out === "none" && fours === 1) {
    out = "four";
    for (let i = 0; i < 4; i++) if (i !== fourDir && dirThreat(board, r, c, color, DIRS[i][0], DIRS[i][1]) === "open_three") { out = "four_three"; break; }
  }
  board[r][c] = ".";
  return out;
}
// Empties on the four lines through (r,c) where `color` completes five: the five points a stone at (r,c) creates.
function fivesThrough(board, r, c, color) {
  const out = [];
  for (const [dr, dc] of DIRS) for (let k = -4; k <= 4; k++) {
    if (!k) continue;
    const rr = r + k * dr, cc = c + k * dc;
    if (inBounds(rr, cc) && board[rr][cc] === "." && makesFive(board, rr, cc, color)) out.push({ r: rr, c: cc, key: key(rr, cc) });
  }
  return out;
}
// Empties on the four lines through (r,c), within four: the only places a stone at (r,c) can create a new threat.
function linePoints(board, r, c) {
  const out = [];
  for (const [dr, dc] of DIRS) for (let k = -4; k <= 4; k++) {
    if (!k) continue;
    const rr = r + k * dr, cc = c + k * dc;
    if (inBounds(rr, cc) && board[rr][cc] === ".") out.push({ r: rr, c: cc, key: key(rr, cc) });
  }
  return out;
}
// Bounded forcing search: who wins if both sides only play fives, forced blocks and unstoppable threats?
// Returns "X" | "O" for a proven winner, null when unresolved within `depth`.
function forcingWinner(board, turn, depth = 6) {
  const other = turn === "X" ? "O" : "X";
  if (fivePointsFor(board, turn).length) return turn;
  const blocks = fivePointsFor(board, other);
  if (blocks.length >= 2) return other;
  if (depth === 0) return null;
  const probe = (p) => {
    board[p.r][p.c] = turn;
    try { return forcingWinner(board, other, depth - 1); } finally { board[p.r][p.c] = "."; }
  };
  if (blocks.length === 1) return probe(fromKey(blocks[0]));
  for (const p of nearPoints(board)) {
    if (!UNSTOPPABLE.has(analyzeMove(board, p.r, p.c, turn).cls)) continue;
    if (probe(p) === turn) return turn;
  }
  return null;
}
const empties = (board, pts) => pts.filter((p) => board[p.r][p.c] === ".");
const union = (a, b) => { const seen = new Set(a.map((p) => p.key)); return a.concat(b.filter((p) => !seen.has(p.key))); };
// `me` to move against `opp`'s threats. `oppPts` ⊇ opp's threat points and `myPts` ⊇ our forcing points (both are
// re-checked; a stone only creates threats on the lines through it, so the sets grow by linePoints of each stone placed).
// Returns the key of a reply after which `opp` has no unstoppable threat and no four that leads to one (a block, or a
// counter-four followed by a block), "-" when there is nothing to answer, and null when every reply loses.
export function holdKey(board, me, opp, depth = 1, oppPts = nearPoints(board), myPts = oppPts) {
  const oppCls = empties(board, oppPts).map((p) => ({ p, cls: quickClass(board, p, opp) }));
  const myCls = empties(board, myPts).map((p) => ({ p, cls: quickClass(board, p, me) }));
  const win = myCls.find((x) => x.cls === "five");
  if (win) return win.p.key;
  const fives = oppCls.filter((x) => x.cls === "five").map((x) => x.p);
  if (fives.length >= 2) return null;
  const oppU = oppCls.filter((x) => UNSTOPPABLE.has(x.cls)).map((x) => x.p);
  const oppF = oppCls.filter((x) => FORCING.has(x.cls)).map((x) => x.p);
  if (!fives.length && !oppU.length) return "-";
  const myF = myCls.filter((x) => FORCING.has(x.cls)).map((x) => x.p);
  const replies = fives.length ? fives : union(oppF, myF);
  const oppStill = (pts) => empties(board, pts).some((t) => UNSTOPPABLE.has(quickClass(board, t, opp)));
  for (const q of replies) {
    board[q.r][q.c] = me;
    let ok = false;
    try {
      if (isWinAt(board, q.r, q.c)) return q.key;
      const myFives = fivesThrough(board, q.r, q.c, me);
      if (myFives.length >= 2) ok = true;
      else if (myFives.length === 1) {
        // a counter-four: opp must block, then we look again
        if (depth > 0) {
          const b = myFives[0];
          board[b.r][b.c] = opp;
          try {
            ok = !isWinAt(board, b.r, b.c) &&
              holdKey(board, me, opp, depth - 1, union(oppPts, linePoints(board, b.r, b.c)), union(myPts, linePoints(board, q.r, q.c))) !== null;
          } finally { board[b.r][b.c] = "."; }
        }
      } else {
        ok = !oppStill(oppU);
        // a plain four first: we block, then opp may have an unstoppable threat, also on the lines through its four
        if (ok && depth > 0) for (const f of oppF) {
          if (board[f.r][f.c] !== "." || !FORCING.has(quickClass(board, f, opp))) continue;
          board[f.r][f.c] = opp;
          try {
            const bl = fivesThrough(board, f.r, f.c, opp);
            if (bl.length >= 2) ok = false;
            else if (bl.length === 1) {
              board[bl[0].r][bl[0].c] = me;
              try {
                if (!fivesThrough(board, bl[0].r, bl[0].c, me).length && oppStill(union(oppU, linePoints(board, f.r, f.c)))) ok = false;
              } finally { board[bl[0].r][bl[0].c] = "."; }
            }
          } finally { board[f.r][f.c] = "."; }
          if (!ok) break;
        }
      }
    } finally { board[q.r][q.c] = "."; }
    if (ok) return q.key;
  }
  return null;
}
// Does `me` playing p lose by force? Returns {by, cls}: the opponent move that wins (an unstoppable threat at once,
// or a four / open three after which no reply holds), or the forced block of our own four when the position after
// the exchange has no holding move (`depth` bounds consecutive own fours; an unproven one counts as lost).
// null when the move holds.
export function dangerOf(board, p, me, opp, depth = 1, oppPts = nearPoints(board), myPts = oppPts) {
  board[p.r][p.c] = me;
  try {
    if (isWinAt(board, p.r, p.c)) return null;
    const five = empties(board, oppPts).find((t) => quickClass(board, t, opp) === "five");
    if (five) return { by: five.key, cls: "five" };
    const myFives = fivesThrough(board, p.r, p.c, me);
    if (myFives.length >= 2) return null;
    const myNext = union(myPts, linePoints(board, p.r, p.c));
    if (myFives.length === 1) {
      const b = myFives[0];
      if (depth <= 0) return { by: b.key, cls: "block" };
      board[b.r][b.c] = opp;
      try {
        if (isWinAt(board, b.r, b.c)) return { by: b.key, cls: "block" };
        return anyHold(board, me, opp, depth - 1, union(oppPts, linePoints(board, b.r, b.c)), myNext) ? null : { by: b.key, cls: "block" };
      } finally { board[b.r][b.c] = "."; }
    }
    const rest = [];
    for (const t of empties(board, oppPts)) {
      const cls = quickClass(board, t, opp);
      // A five or an open four cannot be answered.
      if (cls === "five" || cls === "open_four") return { by: t.key, cls };
      if (!UNSTOPPABLE.has(cls)) { rest.push(t); continue; }
      // A four-plus-three or a double four can be: the forced block may win, make an open four, or counter with a four.
      // The clear cases are settled here; a counter-four or an open block goes through the hold search.
      let verdict = null;
      board[t.r][t.c] = opp;
      try {
        const bl = fivesThrough(board, t.r, t.c, opp);
        if (bl.length !== 1) verdict = "lost";
        else {
          const b = bl[0];
          board[b.r][b.c] = me;
          try {
            const mf = fivesThrough(board, b.r, b.c, me);
            if (isWinAt(board, b.r, b.c) || mf.length >= 2) verdict = "hold";
            else if (!mf.length && empties(board, union(oppPts, linePoints(board, t.r, t.c))).some((u) => UNSTOPPABLE.has(quickClass(board, u, opp)))) verdict = "lost";
          } finally { board[b.r][b.c] = "."; }
        }
        if (verdict === null) verdict = holdKey(board, me, opp, 1, union(oppPts, linePoints(board, t.r, t.c)), myNext) === null ? "lost" : "hold";
      } finally { board[t.r][t.c] = "."; }
      if (verdict === "lost") return { by: t.key, cls };
    }
    // Every four is tried (its answer is forced, so it is cheap) and the six strongest open threes (by class, then by
    // key so the verdict is stable): a bound, not a proof.
    const ts = rest.map((t) => ({ t, cls: classAt(board, t, opp) })).filter((x) => THREAT.has(x.cls));
    ts.sort((x, y) => VALUE[y.cls] - VALUE[x.cls] || (x.t.key < y.t.key ? -1 : 1));
    let n = 0;
    for (const { t, cls } of ts) {
      if (!FORCING.has(cls) && n++ >= 6) continue;
      board[t.r][t.c] = opp;
      try { if (holdKey(board, me, opp, 1, union(oppPts, linePoints(board, t.r, t.c)), myNext) === null) return { by: t.key, cls }; }
      finally { board[t.r][t.c] = "."; }
    }
    return null;
  } finally { board[p.r][p.c] = "."; }
}
// `me` to move: is there a move that does not lose by force? Tried: the opponent's four points, its six strongest open
// threes (by class, then key) and our fours. A bound, not a proof: a defence elsewhere on the line is not tried.
// (No VCF check here: the caller has already run one on this very position through winsByForce.)
function anyHold(board, me, opp, depth, oppPts, myPts) {
  const oppT = empties(board, oppPts).map((t) => ({ t, cls: classAt(board, t, opp) })).filter((x) => THREAT.has(x.cls));
  if (!oppT.length) return true;
  oppT.sort((x, y) => VALUE[y.cls] - VALUE[x.cls] || (x.t.key < y.t.key ? -1 : 1));
  const myF = empties(board, myPts).filter((q) => FORCING.has(quickClass(board, q, me)));
  let n = 0;
  const tries = oppT.filter((x) => FORCING.has(x.cls) || n++ < 6).map((x) => x.t);
  return union(tries, myF).some((q) => dangerOf(board, q, me, opp, depth, oppPts, myPts) === null);
}
// Victory by continuous fours: `me` to move wins by playing only fours (each answered by its single block) up to
// `depth` of them. When the block counters with a four of its own we must block it, and the chain goes on only if
// that block is itself a four; anything unresolved counts as no. The caller guarantees `opp` has no five point.
// `myPts` ⊇ our four points, grown by the lines through each stone.
export function vcf(board, me, opp, depth, myPts) {
  const mine = empties(board, myPts).map((q) => ({ q, cls: quickClass(board, q, me) })).filter((x) => FORCING.has(x.cls));
  if (mine.some((x) => x.cls === "five")) return true;
  if (depth <= 0) return false;
  for (const { q } of mine) {
    board[q.r][q.c] = me;
    try {
      const bl = fivesThrough(board, q.r, q.c, me);
      if (bl.length >= 2) return true;
      if (!bl.length) continue;
      const b = bl[0];
      board[b.r][b.c] = opp;
      try { if (afterBlock(board, me, opp, depth, b, union(myPts, linePoints(board, q.r, q.c)))) return true; } finally { board[b.r][b.c] = "."; }
    } finally { board[q.r][q.c] = "."; }
  }
  return false;
}
// Our four has just been blocked at b (opp's stone is on the board). True when the line still wins: the block did not
// win, and either it made no counter-four (our next voluntary four continues the VCF at depth - 1) or it did and our
// forced block is itself a four, in which case the exchange repeats without consuming depth.
function afterBlock(board, me, opp, depth, b, pts) {
  if (isWinAt(board, b.r, b.c)) return false;
  const counter = fivesThrough(board, b.r, b.c, opp);
  if (counter.length >= 2) return false;
  if (!counter.length) return vcf(board, me, opp, depth - 1, pts);
  const c = counter[0];
  board[c.r][c.c] = me;
  try {
    if (isWinAt(board, c.r, c.c)) return true;
    const bl = fivesThrough(board, c.r, c.c, me);
    if (bl.length >= 2) return true;
    if (!bl.length) return false;
    const d = bl[0];
    board[d.r][d.c] = opp;
    try { return afterBlock(board, me, opp, depth, d, union(pts, linePoints(board, c.r, c.c))); } finally { board[d.r][d.c] = "."; }
  } finally { board[c.r][c.c] = "."; }
}
// A forcing move that wins by force: five, open four, or a four whose block leaves us a VCF (three more fours deep).
function winsByForce(board, p, me, opp, myPts) {
  board[p.r][p.c] = me;
  try {
    if (isWinAt(board, p.r, p.c)) return true;
    const bl = fivesThrough(board, p.r, p.c, me);
    if (bl.length >= 2) return true;
    if (!bl.length) return false;
    const b = bl[0];
    board[b.r][b.c] = opp;
    try { return afterBlock(board, me, opp, 4, b, union(myPts, linePoints(board, p.r, p.c))); } finally { board[b.r][b.c] = "."; }
  } finally { board[p.r][p.c] = "."; }
}

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
// What the opponent already has on the line when our stone stops it from making `cls` there.
const BLOCKS = {
  five: "four", open_four: "open three", four: "three", four_three: "four-plus-three point", double_four: "double-four point",
  double_three: "fork of two open threes", open_three: "open two", three: "two",
};
export function describeCandidate(cand, me, opp) {
  const parts = [];
  if (cand.wins) parts.push(`${me} wins by force`);
  if (cand.me.cls !== "none") parts.push(`${me} makes ${LABEL[cand.me.cls]}${dirNames(cand.me, contributing(cand.me.cls))}`);
  if (VALUE[cand.opp.cls] >= VALUE.three)
    parts.push(`blocks ${opp}'s ${BLOCKS[cand.opp.cls]}${dirNames(cand.opp, contributing(cand.opp.cls))}: ${opp} would make ${LABEL[cand.opp.cls]} here`);
  if (!parts.length) parts.push(cand.adj ? `quiet move next to ${cand.adjMe} ${me} and ${cand.adjOpp} ${opp} stones` : "quiet move away from the stones");
  if (cand.danger) {
    const d = cand.danger;
    if (d.cls === "block") parts.push(`no holding move found after ${opp} blocks at ${d.by}`);
    else if (d.cls === "five" || d.cls === "open_four") parts.push(`loses by force: ${opp} answers at ${d.by} (${LABEL[d.cls]})`);
    else parts.push(`no answer found to ${opp} ${d.by} (${LABEL[d.cls]})`);
  }
  return parts.join("; ");
}

// Ranked candidate list for `me`. Each entry: {key, r, c, me, opp, adj, score, wins, danger, checked, desc}.
// The danger search runs down the ranking until `max` holding moves are found, `probe` moves were checked, or
// `budget` point evaluations are spent (about 1 µs each on a laptop; the heaviest lost-game position needs about 7,000);
// `exhausted` says whether the ranking was searched to the probe limit rather than cut by the budget.
export function candidates(board, me, opp, max = 12, probe = 30, budget = 8000) {
  work = 0; limit = Infinity;
  const near = nearPoints(board, 2);
  const analyzed = near.map((p) => ({ p, a: analyzeMove(board, p.r, p.c, me), b: analyzeMove(board, p.r, p.c, opp) }));
  const oppT = analyzed.filter(({ b }) => THREAT.has(b.cls)).map(({ p }) => p);
  const myF = analyzed.filter(({ a }) => FORCING.has(a.cls)).map(({ p }) => p);
  const all = analyzed.map(({ p, a, b }) => {
    let adjMe = 0, adjOpp = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = p.r + dr, cc = p.c + dc;
      if ((dr || dc) && inBounds(rr, cc)) { if (board[rr][cc] === me) adjMe++; else if (board[rr][cc] === opp) adjOpp++; }
    }
    const adj = adjMe + adjOpp;
    const score = VALUE[a.cls] + 0.9 * VALUE[b.cls] + adj * 3;
    return { ...p, me: a, opp: b, adj, adjMe, adjOpp, score, wins: false, danger: null, checked: false, desc: "" };
  });
  all.sort((x, y) => y.score - x.score);
  let safe = 0, checked = 0, exhausted = true;
  limit = budget;
  try {
    for (const c of all) {
      if (safe >= max || checked >= probe) break;
      try {
        c.wins = FORCING.has(c.me.cls) && winsByForce(board, c, me, opp, myF);
        c.danger = c.wins ? null : dangerOf(board, c, me, opp, 1, oppT, myF);
      } catch (e) {
        if (e !== BUDGET) throw e;
        c.wins = false; c.danger = null; exhausted = false;
        break;
      }
      c.checked = true; checked++;
      if (!c.danger) safe++;
    }
  } finally { limit = Infinity; }
  for (const c of all) c.desc = describeCandidate(c, me, opp);
  all.sort((x, y) => (y.wins - x.wins) || (y.score - x.score));
  return { near, all, top: all.slice(0, max), exhausted };
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
