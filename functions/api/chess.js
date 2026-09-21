// Cloudflare Pages Function: POST /api/chess
import { adapt } from "../_lib/adapter.js";
import { handleChessMove } from "../_lib/chess_move.js";
const h = adapt(handleChessMove);
export const onRequestPost = h.onRequestPost;
export const onRequest = h.onRequest;
