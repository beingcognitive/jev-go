// Sessions: after Google confirms who someone is, the server issues its own signed 30-day session so
// later requests carry a small HMAC token instead of a Google credential. The stored user id is a hash
// of Google's stable subject id; the email is never stored.
import { sign, verify } from "./token.js";
import { verifyGoogleIdToken } from "./google.js";
import { secretOf } from "./session.js";
import { storeFor } from "./store.js";

export const DEFAULT_GOOGLE_CLIENT_ID = "473797382868-5b8l5j9k2c3pueepgqr9hhl8e3qrvjru.apps.googleusercontent.com";
export const clientIdOf = (env = {}) => env.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID;
const SESSION_DAYS = 30;

async function userId(sub) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`google:${sub}`));
  return "g_" + [...new Uint8Array(h)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 24) || "player";

// POST /api/login { credential, state? } -> { session, user: { id, name, picture }, attached }
// `state` is the signed token of the game on screen: holding it proves the caller played that game, so a
// sign-in after the last move (or after a win) still puts the game under the account.
export async function handleLogin(body, env = {}, jwks) {
  try {
    const g = await verifyGoogleIdToken(body && body.credential, clientIdOf(env), jwks);
    const user = { id: await userId(g.sub), name: cleanName(g.given_name || g.name), picture: g.picture };
    const exp = Date.now() + SESSION_DAYS * 86400e3;
    const session = await sign({ v: 1, u: user.id, n: user.name, p: user.picture, exp }, secretOf(env));
    let attached = false, game = null;
    if (body && typeof body.state === "string" && body.state) {
      try {
        const p = await verify(body.state, secretOf(env));
        const g = p && typeof p.id === "string" ? await storeFor(env).attach(p.id, user.id, user.name) : null;
        if (g) { attached = true; game = { id: g.id, name: g.name || null }; } // the stored name wins over the Google name if it was claimed first
      } catch { /* a stale or foreign token attaches nothing; the sign-in itself still succeeds */ }
    }
    return { status: 200, body: { ok: true, session, user, expiresAt: exp, attached, game } };
  } catch (e) {
    return { status: 401, body: { ok: false, error: String(e.message || e) } };
  }
}

// A valid session token -> { id, name, picture }; anything else -> null (anonymous play).
export async function userFromSession(env, session) {
  if (typeof session !== "string" || !session) return null;
  try {
    const p = await verify(session, secretOf(env));
    if (!p || p.v !== 1 || typeof p.u !== "string" || typeof p.exp !== "number" || p.exp < Date.now()) return null;
    return { id: p.u, name: cleanName(p.n), picture: p.p || null };
  } catch { return null; }
}
