// Cloudflare Pages Function: POST /api/move (Gomoku)
import { adapt } from "../_lib/adapter.js";
import { handleMove } from "../_lib/move.js";
const h = adapt(handleMove);
export const onRequestPost = h.onRequestPost;
export const onRequest = h.onRequest;
