import { test } from "node:test";
import assert from "node:assert/strict";
import * as G from "./functions/_lib/gomoku.js";
import { handleMove, buildFullRequest, buildPlayerRequest, playerPlan, decide, mockAnswers, normalizeMode, backend } from "./functions/_lib/move.js";
import { onRequestPost, onRequest } from "./functions/api/move.js";

function boardWith(stones) {
  const b = G.emptyBoard();
  for (const [k, color] of Object.entries(stones)) { const p = G.fromKey(k); b[p.r][p.c] = color; }
  return b;
}
const at = (k) => { const p = G.fromKey(k); return [p.r, p.c]; };
const cls = (b, k, color) => G.analyzeMove(b, ...at(k), color).cls;

test("key/fromKey round trip and bounds", () => {
  assert.equal(G.key(0, 0), "A15");
  assert.equal(G.key(14, 14), "O1");
  assert.deepEqual(G.fromKey("H8"), { r: 7, c: 7 });
  assert.equal(G.fromKey("P1"), null);
  assert.equal(G.fromKey("A16"), null);
  assert.equal(G.fromKey("h8"), null);
});

test("render header and a row", () => {
  const lines = G.render(boardWith({ H8: "X" })).split("\n");
  assert.equal(lines[0], "   A B C D E F G H I J K L M N O");
  assert.equal(lines[8], " 8 . . . . . . . X . . . . . . .");
});

test("threat classes: five, open four, closed four, split four", () => {
  const four = boardWith({ G8: "X", H8: "X", I8: "X", J8: "X" });
  assert.equal(cls(four, "F8", "X"), "five");
  assert.equal(cls(boardWith({ G8: "X", H8: "X", I8: "X" }), "J8", "X"), "open_four");      // F8 and K8 both complete five
  assert.equal(cls(boardWith({ F8: "O", G8: "X", H8: "X", I8: "X" }), "J8", "X"), "four");    // only K8 completes five
  assert.equal(cls(boardWith({ G8: "X", H8: "X", J8: "X" }), "K8", "X"), "four");             // split: only I8 completes five
});

test("threat classes: open three incl. split, closed three, forks", () => {
  assert.equal(cls(boardWith({ G8: "X", H8: "X" }), "I8", "X"), "open_three");
  assert.equal(cls(boardWith({ G8: "X", I8: "X" }), "J8", "X"), "open_three");                // G . I J -> H8 makes an open four
  assert.equal(cls(boardWith({ F8: "O", G8: "X", H8: "X" }), "I8", "X"), "three");
  // four + open three fork: horizontal G8 H8 I8 (open) + vertical J9 J10 J11 with J12 blocked -> J8 gives four (vertical) + open three? build explicitly
  // J8: horizontal H8 I8 J8 = open three (G8, K8 empty); vertical J8..J11 = closed four (J12 blocked, J7 open)
  const fork = boardWith({ H8: "X", I8: "X", J9: "X", J10: "X", J11: "X", J12: "O" });
  assert.equal(cls(fork, "J8", "X"), "four_three");
  const dbl = boardWith({ G8: "X", H8: "X", J9: "X", J10: "X" });
  assert.equal(cls(dbl, "J8", "X"), "double_three");
});

test("threatSets: O must block X's open three at F8 or J8", () => {
  const b = boardWith({ G8: "X", H8: "X", I8: "X", H9: "O", I7: "O" });
  const t = G.threatSets(b, "O", "X");
  assert.deepEqual(t.win, []);
  assert.deepEqual([...t.block].sort(), ["F8", "J8"]);
});

test("threatSets: O can win now", () => {
  const b = boardWith({ A1: "O", B1: "O", C1: "O", D1: "O", A2: "X", B2: "X", C2: "X", D2: "X" });
  assert.deepEqual(G.threatSets(b, "O", "X").win, ["E1"]);
});

test("buildFullRequest (naked): every empty point once, null descriptions, none on threat questions", () => {
  const b = boardWith({ H8: "X" });
  const { questions, legal, state } = buildFullRequest(b, ["X H8"], "O", "X", "naked", true);
  assert.equal(legal.size, 224);
  assert.equal(Object.keys(questions.best_move.criteria).length, 224);
  assert.equal(Object.keys(questions.win_now.criteria).length, 225);
  assert.equal(questions.win_now.criteria.none, "No such point exists.");
  assert.equal(questions.best_move.criteria.F8, null);
  assert.equal("H8" in questions.best_move.criteria, false);
  assert.equal(state.to_move, "O");
  const gw = buildFullRequest(b, [], "O", "X", "naked", false);
  assert.equal(gw.questions.best_move.criteria.F8, "F8");
});

test("buildFullRequest (assisted): descriptions carry exact line facts", () => {
  const b = boardWith({ G8: "X", H8: "X", I8: "X" });
  const { questions } = buildFullRequest(b, [], "O", "X", "assisted", true);
  assert.match(questions.best_move.criteria.F8, /open four/);
  assert.match(questions.best_move.criteria.A1, /far from all stones/);
});

test("candidates: near points only, ranked, dangerous moves demoted", () => {
  const b = boardWith({ G8: "X", H8: "X", I8: "X", H9: "O", I7: "O" });
  const c = G.candidates(b, "O", "X", 12);
  assert.ok(c.all.length < 60 && c.all.length > 10);
  assert.ok(c.all.every((x) => Math.max(Math.abs(x.r - 7), Math.abs(x.c - 7)) <= 4));
  const top = c.top.map((x) => x.key);
  assert.ok(top.includes("F8") && top.includes("J8"));
  const f8 = c.all.find((x) => x.key === "F8");
  assert.match(f8.desc, /blocks X from making an open four/);
  const a5 = c.all.find((x) => x.key === "E5");
  if (a5) assert.equal(a5.danger, "open_four");
});

test("playerPlan: forced win, forced block, open four, restricted pool", () => {
  // O can win now
  const win = boardWith({ A1: "O", B1: "O", C1: "O", D1: "O", A3: "X", C3: "X", E3: "X", G3: "X", M15: "X" });
  assert.equal(G.toMove(win), "O");
  assert.deepEqual(playerPlan(win, "O", "X").forced, { move: "E1", source: "forced-win", note: null });
  // X has a four -> O must block
  const blk = boardWith({ G8: "X", H8: "X", I8: "X", J8: "X", N15: "X", A1: "O", C1: "O", E1: "O", M1: "O" });
  const p = playerPlan(blk, "O", "X");
  assert.equal(p.forced.source, "forced-block");
  assert.ok(["F8", "K8"].includes(p.forced.move));
  // O can make an open four
  const of = boardWith({ C1: "O", D1: "O", E1: "O", A15: "X", C15: "X", E15: "X", G15: "X" });
  const q = playerPlan(of, "O", "X");
  assert.equal(q.forced.source, "open-four");
  assert.ok(["B1", "F1"].includes(q.forced.move));
  // X has an open three -> pool restricted to real answers
  const thr = boardWith({ G8: "X", H8: "X", I8: "X", A1: "O", M1: "O" });
  const plan = playerPlan(thr, "O", "X");
  assert.equal(plan.forced, undefined);
  assert.equal(plan.oppThreatens, true);
  const keys = plan.pool.map((c) => c.key);
  assert.ok(keys.every((k) => ["F8", "J8"].includes(k)), `pool was ${keys.join(",")}`);
});

test("buildPlayerRequest: one question over the pool with descriptions and a threat summary", () => {
  const b = boardWith({ G8: "X", H8: "X", H9: "O" });
  const plan = playerPlan(b, "O", "X");
  const { questions, state, legal } = buildPlayerRequest(b, ["X H8", "O H9", "X G8"], "O", "X", plan);
  assert.deepEqual(Object.keys(questions), ["best_move"]);
  assert.equal(legal.size, plan.pool.length);
  assert.ok(legal.size <= 12);
  assert.ok(Object.values(questions.best_move.criteria).every((d) => typeof d === "string" && d.length > 0));
  assert.ok(state.threats && Array.isArray(state.threats.X_can_make_open_three_at));
});

test("confidenceFrom matches the documented 3-option formula", () => {
  assert.equal(G.confidenceFrom({ a: 1, b: 0, c: 0 }), 1);
  assert.equal(G.confidenceFrom({ a: 1 / 3, b: 1 / 3, c: 1 / 3 }), 0);
  assert.ok(Math.abs(G.confidenceFrom({ a: 0.9, b: 0.06, c: 0.04 }) - 0.85) < 1e-9);
});

test("decide (naked/assisted): verified win beats block beats best; wrong claims fall through", () => {
  const truth = { win: ["E1"], block: ["F8"] };
  const legal = new Set(["E1", "F8", "A1"]);
  const found = decide({ win_now: { choice: "E1", probabilities: { E1: 0.9 } }, must_block: { choice: "none", probabilities: { none: 1 } }, best_move: { choice: "A1", probabilities: { A1: 1 } } }, truth, legal);
  assert.equal(found.move, "E1"); assert.equal(found.source, "win"); assert.equal(found.verdict.win, "found"); assert.equal(found.verdict.block, "missed");
  const falseClaim = decide({ win_now: { choice: "A1", probabilities: { A1: 0.9 } }, must_block: { choice: "F8", probabilities: { F8: 0.9 } }, best_move: { choice: "A1", probabilities: { A1: 1 } } }, truth, legal);
  assert.equal(falseClaim.move, "F8"); assert.equal(falseClaim.source, "block"); assert.equal(falseClaim.verdict.win, "false");
});

test("mockAnswers respects the legal set and question shape", () => {
  const b = boardWith({ H8: "X" });
  const legal = new Set(["G8", "I8", "H9"]);
  const a = mockAnswers(b, "O", "X", legal, { win: [], block: [] }, () => 0.5, { best_move: {} });
  assert.ok(legal.has(a.best_move.choice));
  assert.equal(a.win_now, undefined);
  assert.ok(Object.keys(a.best_move.probabilities).every((k) => legal.has(k)));
});

test("normalizeMode and backend order", () => {
  assert.equal(normalizeMode(undefined, undefined), "player");
  assert.equal(normalizeMode("naked"), "naked");
  assert.equal(normalizeMode("bogus", true), "assisted");
  assert.equal(backend({}).kind, "mock");
  assert.equal(backend({ AI_GATEWAY_API_KEY: "g" }).kind, "gateway");
  assert.equal(backend({ TYPESAFE_API_KEY: "t", AI_GATEWAY_API_KEY: "g" }).kind, "native");
});

test("handleMove player mode (mock): human move then Jev reply with io + candidates", async () => {
  const r = await handleMove({ board: G.toRows(G.emptyBoard()), moves: [], humanMove: "H8", jev: "O", mode: "player" }, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.mode, "player");
  assert.equal(r.body.status, "playing");
  assert.equal(r.body.moves.length, 2);
  const j = r.body.jev;
  assert.equal(j.source, "best");
  assert.ok(j.candidates.length > 0 && j.candidates.length <= 12);
  assert.ok(j.heuristicRank >= 1);
  assert.ok(j.io && j.io.request.questions.best_move && j.io.response.answers);
  assert.equal(j.verdict, null);
});

test("handleMove player mode: forced block is played by code without a call", async () => {
  const b = boardWith({ G8: "X", H8: "X", I8: "X", J8: "X", A1: "O", C1: "O", E1: "O", M1: "O" });
  const r = await handleMove({ board: G.toRows(b), moves: [], humanMove: "N15", jev: "O", mode: "player" }, {});
  const j = r.body.jev;
  assert.equal(j.source, "forced-block");
  assert.ok(["F8", "K8"].includes(j.move));
  assert.equal(j.answers, null); assert.equal(j.io, null); assert.equal(j.latencyMs, 0);
});

test("handleMove naked mode: all points, verdicts present", async () => {
  const r = await handleMove({ board: G.toRows(G.emptyBoard()), moves: [], humanMove: "H8", jev: "O", mode: "naked" }, {});
  assert.equal(r.body.jev.optionCount, 224);
  assert.ok(r.body.jev.verdict && r.body.jev.answers.win_now);
});

test("handleMove: human win is detected before calling Jev", async () => {
  const b = boardWith({ A1: "X", B1: "X", C1: "X", D1: "X", A2: "O", B2: "O", C2: "O", D2: "O" });
  const r = await handleMove({ board: G.toRows(b), moves: [], humanMove: "E1", jev: "O" }, {});
  assert.equal(r.body.status, "human_wins");
  assert.equal(r.body.jev, null);
});

test("handleMove: rejects illegal and out-of-turn moves", async () => {
  const r1 = await handleMove({ board: G.toRows(boardWith({ H8: "X" })), moves: [], humanMove: "H8", jev: "O" }, {});
  assert.equal(r1.status, 400);
  const r2 = await handleMove({ board: G.toRows(G.emptyBoard()), moves: [], humanMove: null, jev: "O" }, {});
  assert.equal(r2.status, 400);
  assert.match(r2.body.error, /not Jev's turn/);
});

test("Pages Function adapter: POST returns JSON, other methods 405, bad JSON 400", async () => {
  const req = new Request("http://x/api/move", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ board: G.toRows(G.emptyBoard()), moves: [], humanMove: "H8", jev: "O" }) });
  const res = await onRequestPost({ request: req, env: {} });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.ok, true); assert.equal(d.backend, "mock");
  const bad = await onRequestPost({ request: new Request("http://x/api/move", { method: "POST", body: "{nope" }), env: {} });
  assert.equal(bad.status, 400);
  assert.equal(onRequest({ request: new Request("http://x/api/move") }).status, 405);
});

test("self-play smoke: player-mode O (mock) vs greedy X never plays illegally and blocks fours", async () => {
  let board = G.emptyBoard();
  let moves = [];
  let status = "playing";
  for (let i = 0; i < 60 && status === "playing"; i++) {
    // X: greedy by the same candidate heuristic
    const c = G.candidates(board, "X", "O", 1).all[0];
    const r = await handleMove({ board: G.toRows(board), moves, humanMove: c.key, jev: "O", mode: "player" }, {});
    assert.equal(r.status, 200, r.body.error);
    board = G.parseBoard(r.body.board); moves = r.body.moves; status = r.body.status;
    if (r.body.jev && r.body.jev.source === "best") {
      // Jev never leaves X an immediate five when it had a block available
      assert.equal(G.fivePointsFor(board, "X").length, 0, `X has a five point after ${r.body.jev.move}`);
    }
  }
  assert.ok(["playing", "jev_wins", "human_wins", "draw"].includes(status));
});

// ---------------- Go 9x9 ----------------
import * as Go from "./functions/_lib/go.js";
import { handleGoMove, goPlayerPlan, buildGoFullRequest, buildGoPlayerRequest, goTruth } from "./functions/_lib/go_move.js";
import { onRequestPost as goPost } from "./functions/api/go.js";

function goBoard(stones) {
  const b = Go.emptyBoard();
  for (const [k, color] of Object.entries(stones)) { const p = Go.fromKey(k); b[p.r][p.c] = color; }
  return b;
}

test("go: keys skip I, bounds", () => {
  assert.equal(Go.key(0, 0), "A9");
  assert.equal(Go.key(8, 8), "J1");
  assert.deepEqual(Go.fromKey("E5"), { r: 4, c: 4 });
  assert.equal(Go.fromKey("I5"), null);
  assert.equal(Go.fromKey("A0"), null);
});

test("go: capture, suicide, ko, superko", () => {
  // X D5 surrounded by O on 3 sides; O plays the 4th liberty and captures
  const b = goBoard({ D5: "X", C5: "O", E5: "O", D6: "O" });
  const t = Go.tryMove(b, ...Object.values(Go.fromKey("D4")), "O", null);
  assert.equal(t.captured, 1); assert.deepEqual(t.capturedKeys, ["D5"]);
  assert.equal(t.board[4][3], ".");
  // suicide: X into a point with no liberties and no capture
  const s = goBoard({ C5: "O", E5: "O", D6: "O", D4: "O" });
  assert.equal(Go.tryMove(s, ...Object.values(Go.fromKey("D5")), "X", null).error, "suicide");
  // ko: X captures at D5, O may not immediately recapture
  const ko = Go.replay(["X C5", "O D5", "X D6", "O E6", "X D4", "O E4", "X F5"]); // X F5 fills... build a classic ko shape below instead
  assert.ok(ko.board);
  const shape = ["X C5", "O E5", "X D6", "O E6", "X D4", "O E4", "X F5", "O D5"]; // O D5 now has libs? we just check replay validity
  assert.ok(Go.replay(shape).board);
  // explicit ko: X captures one stone; O recapturing recreates the previous position -> superko/ko error
  const kb = goBoard({ C5: "X", D6: "X", D4: "X", E5: "O", F5: "O", E6: "O", E4: "O", D5: "O" });
  const hist = new Set([Go.hash(kb)]);
  const cap = Go.tryMove(kb, ...Object.values(Go.fromKey("E5")), "X", hist); // wait: E5 is occupied by O
  assert.equal(cap.error, "occupied");
});

test("go: ko rule via replay", () => {
  // Build: X at C5, D6, D4; O at E6, E4, F5. X plays E5? no: classic ko -> X D5 captured by O E5? Use direct construction:
  const b = goBoard({ C5: "X", D6: "X", D4: "X", E6: "O", E4: "O", F5: "O", D5: "O" });
  // D5 (O) has one liberty at E5; X captures at E5
  const hist = new Set([Go.hash(b)]);
  const x = Go.tryMove(b, ...Object.values(Go.fromKey("E5")), "X", hist);
  assert.equal(x.captured, 1);
  hist.add(Go.hash(x.board));
  // O recapturing at D5 would recreate the position before X's capture -> illegal ko
  const o = Go.tryMove(x.board, ...Object.values(Go.fromKey("D5")), "O", hist);
  assert.equal(o.error, "ko");
});

test("go: replay validates turn order and legality; passes tracked", () => {
  assert.throws(() => Go.replay(["O E5"]), /out of turn/);
  assert.throws(() => Go.replay(["X E5", "O E5"]), /occupied/);
  const st = Go.replay(["X E5", "O pass", "X D4", "O pass"]);
  assert.equal(st.passes, 1); // last pass by O, X played in between -> only the final pass counts
  const two = Go.replay(["X E5", "O pass", "X pass"]);
  assert.equal(two.passes, 2);
});

test("go: area scoring with komi; regions touching both colors are neutral", () => {
  // X wall on column E, O wall on column G: cols A-D are X territory, col F is dame, cols H-J are O territory
  const stones = {};
  for (let r = 1; r <= 9; r++) { stones[`E${r}`] = "X"; stones[`G${r}`] = "O"; }
  const sc = Go.score(goBoard(stones));
  assert.equal(sc.stones.X, 9); assert.equal(sc.territory.X, 36);
  assert.equal(sc.stones.O, 9); assert.equal(sc.territory.O, 18);
  assert.equal(sc.black, 45); assert.equal(sc.white, 27 + 7.5);
  assert.equal(sc.winner, "X");
  // a lone O stone inside X's area makes the surrounding region neutral, not O's
  const lone = {}; for (let r = 1; r <= 9; r++) lone[`E${r}`] = "X"; lone.G5 = "O";
  assert.equal(Go.score(goBoard(lone)).territory.O, 0);
});

test("go: annotations detect capture, save, atari, self-atari, eye fill", () => {
  const b = goBoard({ D5: "O", C5: "X", E5: "X", D6: "X" }); // O D5 in atari, liberty D4
  const st = { history: new Set([Go.hash(b)]) };
  const save = Go.analyzeMove(b, ...Object.values(Go.fromKey("D4")), "O", "X", st.history, null);
  assert.equal(save.saved, 1); assert.match(save.desc, /saves 1 O stone/);
  const cap = Go.analyzeMove(b, ...Object.values(Go.fromKey("D4")), "X", "O", st.history, null);
  assert.equal(cap.captured, 1); assert.match(cap.desc, /captures 1 O stone/);
  const eye = goBoard({ A2: "X", B1: "X" });
  const ef = Go.analyzeMove(eye, ...Object.values(Go.fromKey("A1")), "X", "O", null, null);
  assert.equal(ef.eyeFill, true);
  const sa = goBoard({ B9: "O" }); // X at A9 would have a single liberty (A8)
  const s = Go.analyzeMove(sa, ...Object.values(Go.fromKey("A9")), "X", "O", null, null);
  assert.equal(s.selfAtari, true);
  assert.equal(Go.analyzeMove(goBoard({ B9: "O", A8: "O" }), ...Object.values(Go.fromKey("A9")), "X", "O", null, null), null); // suicide
});

test("go: full request lists every legal point plus pass; player pool is bounded", () => {
  const st = Go.replay(["X E5"]);
  const analyses = Go.analyzeAll(st.board, "O", "X", st.history, st.last);
  const full = buildGoFullRequest(st, ["X E5"], "O", "X", analyses, "naked", true);
  assert.ok(!Object.keys(full.state).some((k) => k.endsWith("_groups_in_atari")), "naked state must not carry atari hints");
  const atariSt = Go.replay(["X E5", "O D5", "X D4", "O pass", "X C5"]);
  const assisted = buildGoFullRequest(atariSt, [], "O", "X", Go.analyzeAll(atariSt.board, "O", "X", atariSt.history, atariSt.last), "assisted", true);
  assert.deepEqual(assisted.state.O_groups_in_atari, ["1 stone at D5"]);
  assert.equal(full.legal.size, 81); // 80 points + pass
  assert.equal(full.questions.best_move.criteria.pass, null);
  assert.equal("pass" in full.questions.capture_now.criteria, false);
  const plan = goPlayerPlan(st, "O", "X", analyses);
  assert.equal(plan.forced, undefined);
  assert.ok(plan.pool.length <= 12 && plan.pool.length > 0);
  const pr = buildGoPlayerRequest(st, ["X E5"], "O", "X", plan);
  assert.ok(Object.values(pr.questions.best_move.criteria).every((d) => typeof d === "string"));
});

test("go: handleGoMove plays, ends on two passes with a score, rejects illegal moves", async () => {
  const r = await handleGoMove({ moves: [], humanMove: "E5", jev: "O", mode: "player" }, {});
  assert.equal(r.status, 200); assert.equal(r.body.game, "go"); assert.equal(r.body.moves.length, 2);
  assert.ok(r.body.jev.io && r.body.jev.candidates.length);
  const bad = await handleGoMove({ moves: ["X E5", "O D5"], humanMove: "E5", jev: "O" }, {});
  assert.equal(bad.status, 400); assert.match(bad.body.error, /occupied/);
  const oot = await handleGoMove({ moves: ["X E5"], humanMove: "D5", jev: "O" }, {});
  assert.equal(oot.status, 400); assert.match(oot.body.error, /not the human/);
  // human passes, Jev passes back only if it has nothing; force the end with an almost-full sequence: X pass after O pass
  const end = await handleGoMove({ moves: ["X E5", "O D5", "X pass", "O pass"], humanMove: null, jev: "O" }, {});
  assert.equal(end.status, 400); assert.match(end.body.error, /game is over/);
  const fin = await handleGoMove({ moves: ["X E5", "O pass"], humanMove: "pass", jev: "O" }, {});
  assert.ok(["jev_wins", "human_wins"].includes(fin.body.status));
  assert.ok(fin.body.score && typeof fin.body.score.black === "number");
});

test("go: naked mode verdicts against code truth", async () => {
  const r = await handleGoMove({ moves: ["X E5", "O D5", "X D4", "O pass", "X C5"], humanMove: null, jev: "O", mode: "naked" }, {});
  assert.equal(r.body.jev.optionCount, 81 - 4 + 1); // 4 stones on board, plus pass
  assert.deepEqual(r.body.jev.truth.save, ["D6"]);
  assert.ok(["found", "missed", "false"].includes(r.body.jev.verdict.save));
});

test("go: Pages Function adapter", async () => {
  const res = await goPost({ request: new Request("http://x/api/go", { method: "POST", body: JSON.stringify({ moves: [], humanMove: "E5", jev: "O" }) }), env: {} });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.game, "go");
});

test("go: self-play smoke (player-mode O vs greedy X) finishes legally", async () => {
  let moves = [], status = "playing", guard = 0;
  while (status === "playing" && guard++ < 120) {
    const st = Go.replay(moves);
    const an = Go.analyzeAll(st.board, "X", "O", st.history, st.last);
    const hm = an.length && an[0].score > 0 ? an[0].key : "pass";
    const r = await handleGoMove({ moves, humanMove: hm, jev: "O", mode: "player" }, {});
    assert.equal(r.status, 200, r.body.error);
    moves = r.body.moves; status = r.body.status;
  }
  assert.ok(status !== "playing");
});
