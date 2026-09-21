# Is Jev a good Gomoku player?

A one-page experiment: you play Gomoku (15×15, five in a row) against **Jev**, TypeSafe AI's
System One decision model, and the page keeps score of how often Jev finds immediate wins and
forced blocks. Hosted on **Cloudflare Pages** with one Pages Function.

## How the prompt works

Every empty point on the board becomes one option of a `choice` question. Nothing is hand-picked,
so Jev can never play an illegal move. Three questions go out in one call against the same state:

| question     | asks                                                                 | options          |
|--------------|----------------------------------------------------------------------|------------------|
| `win_now`    | the point where Jev makes five in a row, or `none`                   | empties + `none` |
| `must_block` | the point where the human makes five or an open four next, or `none` | empties + `none` |
| `best_move`  | the strongest move                                                   | empties          |

Code computes the ground truth for the two threat questions and **verifies** Jev's claims before
playing them. Priority: verified win → verified block → `best_move`. A wrong claim falls through
and is logged as a false claim. Detection rates, latency and token usage are tallied per game and
across games (localStorage).

**Assisted mode** replaces the plain option descriptions (`"F8": "column F, row 8"`) with
code-computed line facts (`"blocks X's open three"`), so Jev reads labels instead of the grid.
Leave it off to measure Jev itself.

## Layout

```
functions/api/move.js     Cloudflare Pages Function: POST /api/move
functions/_lib/move.js    runtime-agnostic core (prompt build, Jev call, verify, decide)
functions/_lib/gomoku.js  board, win/threat detection, option descriptions
public/index.html         the page
dev.mjs                   plain Node dev server (no wrangler needed)
test.mjs                  node:test suite
wrangler.toml             Pages project config
```

## Backend selection

`TYPESAFE_API_KEY` → TypeSafe native `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`.
`AI_GATEWAY_API_KEY` (only if the first is empty) → Vercel AI Gateway, model `typesafe-ai/jev`.
Neither → a heuristic mock, shown as a `mock` badge on the page.

## Run locally

```bash
cp .dev.vars.example .dev.vars   # paste TYPESAFE_API_KEY, or leave empty for mock mode
npm test
npm run dev                      # plain Node, http://localhost:3000
npm run cf:dev                   # or the real Pages runtime via wrangler, http://localhost:8788
```

## Deploy to Cloudflare Pages

```bash
npx wrangler login                                   # once
npx wrangler pages deploy public                     # creates the project "jev-go" on first run
npx wrangler pages secret put TYPESAFE_API_KEY       # paste the key when prompted
npx wrangler pages deploy public                     # deploy again so the secret is live
```

The site lands at `https://jev-go.pages.dev`. Until the secret is set, the deployed page runs
in mock mode.

## Cost

Jev bills input only, $0.042 per million tokens. A move with all ~200 options is roughly
7,500 input tokens, about $0.0003, so a full game is under a cent. If you want it cheaper or
want Jev to see fewer distractors, prune the option set to points within two of any stone.
