// Cloudflare Pages Function: GET /api/leaderboard?game=gomoku|go|chess
import { adaptGet } from "../_lib/adapter.js";
import { handleLeaderboard } from "../_lib/records.js";
const h = adaptGet(handleLeaderboard, 30); // CDN-cached for 30 s: at most two D1 reads a minute per game type, whatever the traffic
export const onRequestGet = h.onRequestGet;
export const onRequest = h.onRequest;
