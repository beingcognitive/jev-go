# Is Jev a good Gomoku player?

A one-page experiment: you play Gomoku (15×15, five in a row) against **Jev**, TypeSafe AI's
System One decision model, and the page keeps score of how often Jev finds immediate wins and
forced blocks. Hosted on **Cloudflare Pages** with one Pages Function.

## Three modes

| mode | what code does | what Jev sees | who decides |
|---|---|---|---|
| **Player** (default) | full perception: fives, open/closed/split fours, open threes, forks, "this move loses next turn"; plays forced wins and blocks itself; prunes to a ranked pool of ~12 candidates | one `choice` question over the pool, each option annotated with exactly what it creates and blocks, plus a threat summary in the state | code for forced tactics, **Jev for everything else** |
| **Assisted** | annotates every empty point with the same line facts | three `choice` questions (`win_now`, `must_block`, `best_move`) over all empty points | Jev; win/block claims are verified before being played |
| **Naked** | nothing | the same three questions, every empty point, no descriptions | Jev alone. Measurement mode. |

In Player mode the page shows where Jev's pick ranked in the code heuristic's ordering
("Heur. #k"), so you can see whether Jev's judgment agrees with, beats, or ignores the
1-ply evaluation. Forced moves are logged as `forced-win`, `forced-block` and `open-four`
and cost no call.

Every Jev call's full request payload and raw response are shown in the **Jev API calls**
panel, one expandable entry per move, with copy buttons.

## Layout

```
functions/api/move.js     Cloudflare Pages Function: POST /api/move
functions/_lib/move.js    runtime-agnostic core (prompt build, Jev call, verify, decide)
functions/_lib/gomoku.js  threat engine, candidate ranking, option descriptions
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
