// Pages Function adapters. A core handler returns { status, body, after? }; `after` is a function returning
// a promise (record writes) that runs after the response via waitUntil.
const json = (body, status) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function adapt(handler) {
  return {
    async onRequestPost({ request, env, waitUntil }) {
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: "invalid JSON" }, 400); }
      const r = await handler(body, env);
      if (r.after) { const p = r.after().catch(() => {}); if (typeof waitUntil === "function") waitUntil(p); else await p; }
      return json(r.body, r.status);
    },
    onRequest() {
      return json({ ok: false, error: "POST only" }, 405);
    },
  };
}

// GET handlers: `handler(params, query, env) -> { status, body }`.
export function adaptGet(handler) {
  return {
    async onRequestGet({ request, env, params }) {
      const url = new URL(request.url);
      const r = await handler(params || {}, Object.fromEntries(url.searchParams), env);
      return json(r.body, r.status);
    },
    onRequest() {
      return json({ ok: false, error: "GET only" }, 405);
    },
  };
}
