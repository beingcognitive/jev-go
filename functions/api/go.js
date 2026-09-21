// Cloudflare Pages Function: POST /api/go (Go 9x9)
import { adapt } from "../_lib/adapter.js";
import { handleGoMove } from "../_lib/go_move.js";
const h = adapt(handleGoMove);
export const onRequestPost = h.onRequestPost;
export const onRequest = h.onRequest;
