// Cloudflare Pages Function: POST /api/login { credential } (a Google Sign-In ID token)
import { adapt } from "../_lib/adapter.js";
import { handleLogin } from "../_lib/auth.js";
const h = adapt((body, env) => handleLogin(body, env));
export const onRequestPost = h.onRequestPost;
export const onRequest = h.onRequest;
