// Pages Function adapter: Request/env in, JSON Response out, for a core `handler(body, env) -> {status, body}`.
const json = (body, status) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function adapt(handler) {
  return {
    async onRequestPost({ request, env }) {
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: "invalid JSON" }, 400); }
      const r = await handler(body, env);
      return json(r.body, r.status);
    },
    onRequest() {
      return json({ ok: false, error: "POST only" }, 405);
    },
  };
}
