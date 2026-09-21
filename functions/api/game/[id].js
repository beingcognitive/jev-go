// Cloudflare Pages Function: GET /api/game/<id>[?io=1]
import { adaptGet } from "../../_lib/adapter.js";
import { handleGame } from "../../_lib/records.js";
const h = adaptGet(handleGame);
export const onRequestGet = h.onRequestGet;
export const onRequest = h.onRequest;
