# jev-go — Can you beat Jev at Gomoku, Go or chess?

**Live:** https://jev-go.chardonn.ai

Play 15×15 Gomoku, 9×9 Go or chess against **Jev**, TypeSafe AI's System One decision model.
Code does the perception, Jev does the judgment, and every API call is shown on the page.
Hosted on **Cloudflare Pages** with three Pages Functions, one per game.

![Gomoku board with Jev's candidate pool and probabilities](docs/img/gomoku-board.png)

## Three modes

The page plays **Player** mode only; Assisted and Naked stay in the API (`mode` in the request body)
for measurement.

| mode | what code does | what Jev sees | who decides |
|---|---|---|---|
| **Player** (default) | full perception: fives, open/closed/split fours, open threes, forks, "this move loses next turn"; plays forced wins and blocks itself; prunes to a ranked pool of ~12 candidates | one `choice` question over the pool, each option annotated with exactly what it creates and blocks, plus a threat summary in the state | code for forced tactics, **Jev for everything else** |
| **Assisted** | annotates every empty point with the same line facts | three `choice` questions (`win_now`, `must_block`, `best_move`) over all empty points | Jev; win/block claims are verified before being played |
| **Naked** | nothing | the same three questions, every empty point, no descriptions | Jev alone. Measurement mode. |

In Player mode the page shows where Jev's pick ranked in the code heuristic's ordering
("Heur. #k"), so you can see whether Jev's judgment agrees with, beats, or ignores the
1-ply evaluation. Forced moves are logged as `forced-win`, `forced-block` and `open-four`
and cost no call.

Every Jev call's full request payload and raw response are shown under the board, one
expandable entry per move, with copy buttons.

## The page

Built phone-first. The board is measured from its column so it never scrolls sideways; on a phone a
first tap aims a stone (a ghost appears with a "Place H8" button) and a second tap plays it, while a
mouse previews on hover and plays on click. Under the board: the status line with the record chip
(Recorded, Recorded as Name, Practice opponent, Not recorded), Pass or Place when needed, the result
card at game end, a one-line card saying what Jev played, how sure it was and why, and then every
call to Jev with the exact request and raw response. Jev's likely moves are drawn on the board after
its move and fade when you start yours. The top bar holds the menu (game, new game, your games, hall
of fame, about Jev), this game's numbers in the centre on wide screens, and sign-in. Jev's candidate list and the
per-move table sit beside the board on wide screens and below it on a phone.

## Go 9×9

The same three modes apply. Code implements captures, suicide, **positional superko**, area
scoring (Chinese rules, komi 7.5) and two-pass game end, replaying the move list on every
request so the history is authoritative. For every legal point it computes what the move
captures, saves, threatens (atari), connects, whether it is self-atari or fills an own eye,
the line, and the liberties left, and ranks them.

- **Player**: Jev picks from the top ~12 annotated points; `pass` is offered only after the
  opponent passed, when nothing scores, or near the 200-move cap.
- **Assisted / Naked**: every legal point plus `pass`; questions are `capture_now`,
  `must_save` and `best_move`, verified against code truth before being played.

Dead stones are not removed at the end, so capture them before passing.

## Screenshots

Player mode, Jev (white) wins a Gomoku game. The scoresheet: the last call, per-move table
with where Jev's pick ranked in the heuristic, and the API log.

![Jev's last thought, per-move table and stats](docs/img/gomoku-thought.png)

Every call, expandable, with the exact request and Jev's raw response:

![Jev API calls panel](docs/img/gomoku-api-log.png)

## Chess

Standard chess with rules from the vendored [chess.js](https://github.com/jhlywa/chess.js) 1.4.0
(BSD-2-Clause, `functions/_lib/vendor/`). X is White. The pieces are Colin M.L. Burnett's SVG set (CC BY-SA 3.0, via Wikimedia Commons), inlined as a sprite. The server returns an HMAC-signed snapshot of the
position (FEN plus a repetition table) that the client sends back, so a request loads the position in
microseconds instead of replaying the move list; the list is still sent as context for Jev, and a request
without a valid snapshot falls back to replaying it. For every legal move code computes what it captures, whether the moved
piece can be taken back (attacked and undefended, or by something cheaper; a king only takes an
undefended piece), what other piece it leaves en prise, what it threatens, check, mate, castling,
development, and ranks them. Piece safety is a static exchange over every attacker and defender on the
square (pinned pieces are treated as free to move); there is no search.

- **Player**: code plays mate in one; otherwise Jev picks from the top 12 annotated moves.
- **Assisted / Naked**: every legal move, in SAN order; questions `mate_now`, `win_material`,
  `best_move`, verified before being played.

## Leaderboard and replays

Every verified game is recorded by the server: one row per game and one per ply, including Jev's
top-5 probabilities, the probability it gave the move it played, verdicts, latency, tokens and the
raw request/response. A game is verified when it was played move by move through the signed session
token the server issues (all three games use one now), so a recorded win was produced on the server,
not posted by a client. Games played without a key (mock) are recorded but never count.

- **Leaderboard** (`GET /api/leaderboard?game=gomoku`): human wins against the real Jev, fewest
  plies first, with the model version. Winners can claim a display name once (`POST /api/claim`).
- **Replay** (`?replay=<id>` on the page, `GET /api/game/<id>`): step through any recorded game with
  Jev's thoughts on every one of its moves.

Storage is Cloudflare D1, set up in the dashboard: Workers & Pages → D1 → create a database named
`jev-go`, run `schema.sql` in its Console tab, then in the Pages project's Settings → Bindings add a
D1 binding with variable name `DB` for Production and Preview, and redeploy. Without the binding the
server keeps records in memory only.

When `schema.sql` gains a column, an existing database needs the matching file under `migrations/`
run in the same Console tab (`CREATE TABLE IF NOT EXISTS` never alters a table that exists). The
leaderboard response carries `schema`: `"ok"`, or the database's own error when a column the code
writes is missing, in which case no game is being recorded until the migration runs.

## Sign in with Google

Playing the live Jev needs a Google sign-in: the first touch of the board (or "New game, Jev opens")
opens a small dialog with Google's button, and the server refuses a live move without a valid session,
so every recorded game and every hall-of-fame win carries a name. Practice games (no key) stay open.
The browser posts the ID token to `POST /api/login`, the server verifies Google's RS256 signature against
Google's published keys with WebCrypto, checks issuer, audience and expiry, and issues its own 30-day
HMAC session. Every move then carries the session; `POST /api/me` lists your games with replay links on
any device. Signing in again after a session expired mid-game still keeps the game: the login request
carries the game's signed state token, which proves you played it, and the server attaches the game to the
account. The record chip next to the status line says whether the game on screen counts and under which
name. (`POST /api/claim`, the old name form for anonymous wins, still exists but the page no longer uses it.)

Stored: a hash of the Google subject id and the display name. Never the email or anything from the
mailbox; sign-in requests identity only. The OAuth client id is public and set in the page and in
`functions/_lib/auth.js` (override with a `GOOGLE_CLIENT_ID` variable). Authorized origins:
`https://jev-go.chardonn.ai` and `http://localhost:3111`.

## Layout

```
functions/api/move.js     Pages Function: POST /api/move (Gomoku)
functions/api/go.js       Pages Function: POST /api/go   (Go 9×9)
functions/api/chess.js    Pages Function: POST /api/chess
functions/api/leaderboard.js, game/[id].js, claim.js, me.js, login.js   records and sign-in API
functions/_lib/session.js, store.js, records.js         signed sessions, D1/memory store, read cores
functions/_lib/google.js, auth.js                       Google ID token verification, player sessions
functions/_lib/move.js    runtime-agnostic core (prompt build, Jev call, verify, decide)
functions/_lib/gomoku.js  Gomoku threat engine, candidate ranking, descriptions
functions/_lib/go.js      Go engine: groups, captures, superko, scoring, annotations
functions/_lib/go_move.js Go handler core
functions/_lib/chess.js   chess annotations on top of vendored chess.js
functions/_lib/chess_move.js chess handler core
functions/_lib/jev.js     shared Jev transport (TypeSafe API, or a mock when no key is set)
public/index.html         the page
dev.mjs                   plain Node dev server (no wrangler needed)
test.mjs                  node:test suite
wrangler.toml             Pages project config
```

## Backend selection

With `TYPESAFE_API_KEY` set, every move is one `POST https://api.typesafe.ai/v1/systemone` with model
`jev-latest`. Without it the server plays a heuristic stand-in and the record chip next to the status
line reads "Practice opponent" instead of "Recorded", so the app runs locally with no key. `STATE_SECRET` optionally signs the chess state tokens; it defaults to the API key.

## Run locally

```bash
cp .dev.vars.example .dev.vars   # paste TYPESAFE_API_KEY, or leave empty for mock mode
npm test
npm run dev                      # plain Node, http://localhost:3000
npm run cf:dev                   # or the real Pages runtime via wrangler, http://localhost:8788
```

## Deploy to Cloudflare Pages

The project is connected to this GitHub repository in the Cloudflare dashboard: every push to `main`
deploys. Build command empty, output directory `public`. Secrets live in the project's Settings →
Variables and Secrets: `TYPESAFE_API_KEY` (required for the real Jev) and optionally `STATE_SECRET`.
Until the key is set, the deployed page runs in mock mode.

## Cost

Jev bills input only, $0.042 per million tokens. Measured: Player mode is about 1,100 input tokens
per call (a 20-call Gomoku game costs about a tenth of a cent); Naked and Assisted send every empty
point and run about 13,000 tokens per call on Gomoku, far fewer on Go and chess. Either way a game
is well under a cent.
