// Signed, stateless game tokens: the server hands the client an HMAC-signed snapshot and accepts it back,
// so a request costs O(1) instead of replaying the whole move list. WebCrypto is available in Workers and Node.

const enc = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (ch) => ch.charCodeAt(0));

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function sign(obj, secret) {
  const payload = b64u(enc.encode(JSON.stringify(obj)));
  return `${payload}.${b64u(await hmac(secret, payload))}`;
}

// Returns the object, or throws "bad state" on any malformed or tampered token.
export async function verify(token, secret) {
  if (typeof token !== "string" || token.length > 8192) throw new Error("bad state");
  const dot = token.indexOf(".");
  if (dot < 1) throw new Error("bad state");
  const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  const expected = b64u(await hmac(secret, payload));
  if (sig.length !== expected.length) throw new Error("bad state");
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) throw new Error("bad state");
  try { return JSON.parse(new TextDecoder().decode(unb64u(payload))); } catch { throw new Error("bad state"); }
}
