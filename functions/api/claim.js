// Cloudflare Pages Function: POST /api/claim { state, name }
import { adapt } from "../_lib/adapter.js";
import { handleClaim } from "../_lib/records.js";
const h = adapt(handleClaim);
export const onRequestPost = h.onRequestPost;
export const onRequest = h.onRequest;
