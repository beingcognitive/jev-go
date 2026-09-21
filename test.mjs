import { test } from "node:test";
import assert from "node:assert/strict";
import * as G from "./functions/_lib/gomoku.js";
import { handleMove, buildRequest, decide, mockAnswers } from "./functions/_lib/move.js";
import { onRequestPost, onRequest } from "./functions/api/move.js";

function boardWith(stones) {
  const b = G.emptyBoard();
  for (const [k, color] of Object.entries(stones)) { const p = G.fromKey(k); b[p.r][p.c] = color; }
  return b;
}

test("key/fromKey round trip and bounds", () => {
  assert.equal(G.key(0, 0), "A15");
  assert.equal(G.key(14, 14), "O1");
  assert.deepEqual(G.fromKey("H8"), { r: 7, c: 7 });
  assert.equal(G.fromKey("P1"), null);
  assert.equal(G.fromKey("A16"), null);
  assert.equal(G.fromKey("h8"), null);
});

test("render header and a row", () => {
  const b = boardWith({ H8: "X" });
  const lines = G.render(b).split("\n");
  assert.equal(lines[0], "   A B C D E F G H I J K L M N O");
  assert.equal(lines[8], " 8 . . . . . . . X . . . . . . .");
});

test("makesFive / open four / open three", () => {
  const b = boardWith({ G8: "X", H8: "X", I8: "X", J8: "X" });
  assert.equal(G.makesFive(b, ...Object.values(G.fromKey("F8")), "X"), true);
  assert.equal(G.makesFive(b, ...Object.values(G.fromKey("K8")), "X"), true);
  assert.equal(G.makesFive(b, ...Object.values(G.fromKey("F9")), "X"), false);
  const three = boardWith({ G8: "X", H8: "X", I8: "X" });
  assert.equal(G.makesOpenFour(three, ...Object.values(G.fromKey("F8")), "X"), true);
  assert.equal(G.makesOpenFour(three, ...Object.values(G.fromKey("J8")), "X"), true);
  assert.equal(G.makesOpenThree(boardWith({ H8: "X", I8: "X" }), ...Object.values(G.fromKey("G8")), "X"), true);
});

test("threatSets: O must block X's open three at F8 or J8", () => {
  const b = boardWith({ G8: "X", H8: "X", I8: "X", H9: "O", I7: "O" });
  const t = G.threatSets(b, "O", "X");
  assert.deepEqual(t.win, []);
  assert.deepEqual([...t.block].sort(), ["F8", "J8"]);
});

test("threatSets: O can win now", () => {
  const b = boardWith({ A1: "O", B1: "O", C1: "O", D1: "O", A2: "X", B2: "X", C2: "X", D2: "X" });
  const t = G.threatSets(b, "O", "X");
  assert.deepEqual(t.win, ["E1"]);
});

test("buildRequest lists every empty point exactly once, plus none on threat questions", () => {
  const b = boardWith({ H8: "X" });
  const { questions, legal, state } = buildRequest(b, ["X H8"], "O", "X", false);
  assert.equal(legal.size, 224);
  assert.equal(Object.keys(questions.best_move.criteria).length, 224);
  assert.equal(Object.keys(questions.win_now.criteria).length, 225);
  assert.equal(questions.win_now.criteria.none, "No such point exists.");
  assert.equal(questions.best_move.criteria.F8, "column F, row 8");
  assert.equal("H8" in questions.best_move.criteria, false);
  assert.equal(state.to_move, "O");
  assert.equal(state.board.length, 16);
});

test("assisted descriptions carry line facts", () => {
  const b = boardWith({ G8: "X", H8: "X", I8: "X" });
  const { questions } = buildRequest(b, [], "O", "X", true);
  assert.match(questions.best_move.criteria.F8, /blocks X's open four/);
  assert.match(questions.best_move.criteria.A1, /far from all stones/);
});

test("confidenceFrom matches the documented 3-option formula", () => {
  assert.equal(G.confidenceFrom({ a: 1, b: 0, c: 0 }), 1);
  assert.equal(G.confidenceFrom({ a: 1 / 3, b: 1 / 3, c: 1 / 3 }), 0);
  assert.ok(Math.abs(G.confidenceFrom({ a: 0.9, b: 0.06, c: 0.04 }) - 0.85) < 1e-9);
});

test("decide: verified win beats block beats best; wrong claims fall through", () => {
  const truth = { win: ["E1"], block: ["F8"] };
  const legal = new Set(["E1", "F8", "A1"]);
  const found = decide(
    { win_now: { choice: "E1", probabilities: { E1: 0.9 } }, must_block: { choice: "none", probabilities: { none: 1 } }, best_move: { choice: "A1", probabilities: { A1: 1 } } },
    truth, legal);
  assert.equal(found.move, "E1"); assert.equal(found.source, "win"); assert.equal(found.verdict.win, "found"); assert.equal(found.verdict.block, "missed");
  const falseClaim = decide(
    { win_now: { choice: "A1", probabilities: { A1: 0.9 } }, must_block: { choice: "F8", probabilities: { F8: 0.9 } }, best_move: { choice: "A1", probabilities: { A1: 1 } } },
    truth, legal);
  assert.equal(falseClaim.move, "F8"); assert.equal(falseClaim.source, "block"); assert.equal(falseClaim.verdict.win, "false");
  const none = decide(
    { win_now: { choice: "none", probabilities: { none: 1 } }, must_block: { choice: "none", probabilities: { none: 1 } }, best_move: { probabilities: { A1: 0.7, F8: 0.3 } } },
    { win: [], block: [] }, legal);
  assert.equal(none.move, "A1"); assert.equal(none.source, "best"); assert.equal(none.verdict.win, "correct_none");
});

test("mockAnswers returns legal choices with probabilities over legal keys", () => {
  const b = boardWith({ H8: "X" });
  const { legal } = buildRequest(b, [], "O", "X", false);
  const a = mockAnswers(b, "O", "X", legal, { win: [], block: [] }, () => 0.5);
  assert.ok(legal.has(a.best_move.choice));
  assert.equal(a.win_now.choice, "none");
  const sum = Object.values(a.best_move.probabilities).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("handleMove (mock backend): human move then Jev reply", async () => {
  const r = await handleMove({ board: G.toRows(G.emptyBoard()), moves: [], humanMove: "H8", jev: "O", assist: false }, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.backend, "mock");
  assert.equal(r.body.status, "playing");
  assert.equal(r.body.moves.length, 2);
  assert.equal(r.body.jev.optionCount, 224);
  assert.ok(G.fromKey(r.body.jev.move));
  const { X, O } = G.counts(G.parseBoard(r.body.board));
  assert.deepEqual({ X, O }, { X: 1, O: 1 });
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

test("backend prefers the native TypeSafe key, then Gateway, else mock", async () => {
  const { backend } = await import("./functions/_lib/move.js");
  assert.equal(backend({}).kind, "mock");
  assert.equal(backend({ AI_GATEWAY_API_KEY: "g" }).kind, "gateway");
  assert.equal(backend({ TYPESAFE_API_KEY: "t", AI_GATEWAY_API_KEY: "g" }).kind, "native");
});

test("Pages Function adapter: POST returns JSON, other methods 405, bad JSON 400", async () => {
  const req = new Request("http://x/api/move", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ board: G.toRows(G.emptyBoard()), moves: [], humanMove: "H8", jev: "O" }) });
  const res = await onRequestPost({ request: req, env: {} });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  const d = await res.json();
  assert.equal(d.ok, true); assert.equal(d.backend, "mock"); assert.equal(d.moves.length, 2);
  const bad = await onRequestPost({ request: new Request("http://x/api/move", { method: "POST", body: "{nope" }), env: {} });
  assert.equal(bad.status, 400);
  const get = onRequest({ request: new Request("http://x/api/move") });
  assert.equal(get.status, 405);
});
