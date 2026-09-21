// Cloudflare Pages Function: POST /api/move
import { handleMove } from "../_lib/move.js";

const json = (body, status) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "invalid JSON" }, 400); }
  const r = await handleMove(body, env);
  return json(r.body, r.status);
}

export function onRequest() {
  return json({ ok: false, error: "POST only" }, 405);
}
