// Pages Function adapters. A core handler returns { status, body, after? }; `after` is a function returning
// a promise (record writes) that runs after the response via waitUntil.
const json = (body, status, cacheSeconds = 0) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": cacheSeconds ? `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}` : "no-store" } });

export function adapt(handler) {
  return {
    async onRequestPost({ request, env, waitUntil }) {
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: "invalid JSON" }, 400); }
      const r = await handler(body, env);
      if (r.after) { const p = r.after().catch((e) => console.error("record failed:", e && e.message || e)); if (typeof waitUntil === "function") waitUntil(p); else await p; } // visible in the Functions log, never in the response
      return json(r.body, r.status);
    },
    onRequest() {
      return json({ ok: false, error: "POST only" }, 405);
    },
  };
}

// GET handlers: `handler(params, query, env) -> { status, body }`.
export function adaptGet(handler, cacheSeconds = 0) {
  return {
    async onRequestGet({ request, env, params }) {
      const url = new URL(request.url);
      const r = await handler(params || {}, Object.fromEntries(url.searchParams), env);
      return json(r.body, r.status, r.status === 200 && r.cache !== false ? cacheSeconds : 0);
    },
    onRequest() {
      return json({ ok: false, error: "GET only" }, 405);
    },
  };
}
