// Cloudflare Pages Function: GET /api/leaderboard?game=gomoku|go|chess
import { adaptGet } from "../_lib/adapter.js";
import { handleLeaderboard } from "../_lib/records.js";
const h = adaptGet(handleLeaderboard);
export const onRequestGet = h.onRequestGet;
export const onRequest = h.onRequest;
