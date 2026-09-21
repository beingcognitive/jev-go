// Cloudflare Pages Function: POST /api/me { session } -> the signed-in player's games
import { adapt } from "../_lib/adapter.js";
import { handleMe } from "../_lib/records.js";
const h = adapt(handleMe);
export const onRequestPost = h.onRequestPost;
export const onRequest = h.onRequest;
