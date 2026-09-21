// Verify a Google Sign-In ID token (RS256) against Google's published keys. No SDK, WebCrypto only.
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (ch) => ch.charCodeAt(0));
const json = (bytes) => JSON.parse(new TextDecoder().decode(bytes));

let cache = { keys: null, until: 0 };
export async function googleJwks() {
  if (cache.keys && Date.now() < cache.until) return cache.keys;
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error("google keys unavailable");
  const body = await r.json();
  const maxAge = /max-age=(\d+)/.exec(r.headers.get("cache-control") || "");
  cache = { keys: body.keys || [], until: Date.now() + (maxAge ? Number(maxAge[1]) : 3600) * 1000 };
  return cache.keys;
}

// Returns { sub, email, email_verified, name, given_name, picture } or throws "bad credential".
export async function verifyGoogleIdToken(credential, clientId, jwks = googleJwks) {
  if (typeof credential !== "string" || credential.length > 4096) throw new Error("bad credential");
  const parts = credential.split(".");
  if (parts.length !== 3) throw new Error("bad credential");
  let header, payload;
  try { header = json(unb64u(parts[0])); payload = json(unb64u(parts[1])); } catch { throw new Error("bad credential"); }
  if (header.alg !== "RS256" || !header.kid) throw new Error("bad credential");
  const key = (await jwks()).find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!key) throw new Error("bad credential");
  const pub = await crypto.subtle.importKey("jwk", { kty: key.kty, n: key.n, e: key.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, unb64u(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error("bad credential");
  const now = Math.floor(Date.now() / 1000);
  if (!ISSUERS.has(payload.iss) || payload.aud !== clientId || typeof payload.sub !== "string") throw new Error("bad credential");
  if (typeof payload.exp !== "number" || payload.exp < now - 60) throw new Error("credential expired");
  return { sub: payload.sub, email: payload.email || null, email_verified: !!payload.email_verified, name: payload.name || payload.given_name || null, given_name: payload.given_name || null, picture: payload.picture || null };
}
