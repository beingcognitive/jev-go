// Plain Node dev server (no wrangler needed): serves public/ and routes POST /api/move to the core handler.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

for (const f of [".dev.vars", ".env"]) { try { process.loadEnvFile(f); break; } catch {} }
const { handleMove, backend } = await import("./functions/_lib/move.js");
const { handleGoMove } = await import("./functions/_lib/go_move.js");
const { handleChessMove } = await import("./functions/_lib/chess_move.js");
const { handleLeaderboard, handleGame, handleClaim } = await import("./functions/_lib/records.js");

const PORT = Number(process.env.PORT || 3000);
const PUB = path.join(process.cwd(), "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/api/leaderboard") {
    const r = await handleLeaderboard({}, Object.fromEntries(url.searchParams), process.env);
    res.writeHead(r.status, { "content-type": "application/json" }); return res.end(JSON.stringify(r.body));
  }
  const gm = req.method === "GET" && /^\/api\/game\/([^/]+)$/.exec(url.pathname);
  if (gm) {
    const r = await handleGame({ id: gm[1] }, Object.fromEntries(url.searchParams), process.env);
    res.writeHead(r.status, { "content-type": "application/json" }); return res.end(JSON.stringify(r.body));
  }
  if (url.pathname === "/api/move" || url.pathname === "/api/go" || url.pathname === "/api/chess" || url.pathname === "/api/claim") {
    const handle = url.pathname === "/api/go" ? handleGoMove : url.pathname === "/api/chess" ? handleChessMove : url.pathname === "/api/claim" ? handleClaim : handleMove;
    if (req.method !== "POST") { res.writeHead(405, { "content-type": "application/json" }); return res.end('{"ok":false,"error":"POST only"}'); }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body;
    try { body = JSON.parse(raw || "{}"); } catch { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"ok":false,"error":"invalid JSON"}'); }
    const r = await handle(body, process.env);
    if (r.after) await r.after().catch((e) => console.error("record failed:", e.message));
    res.writeHead(r.status, { "content-type": "application/json" });
    return res.end(JSON.stringify(r.body));
  }
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`dev server on http://localhost:${PORT}  backend=${backend(process.env).kind}`));
