# Digital Diary

A personal diary that I write to from Telegram, and read on the web.

I used to write a journal at night, about what I did, learned, and thought that day. Writing it by hand took time, and I rarely kept it up. This project makes that quicker: I send a message (text or, later, a voice note) to a Telegram bot, and it lands in the right day, in the right category, with the original kept.

The longer goal is to keep a record of how I change over time: habits, projects, what I learn, and how my thinking shifts. The diary is the first step. Patterns and reflections come after I have a few months of data.

## What it does today

- Receives text from a Telegram bot, and only from my own chat.
- Stores every message as a raw capture before doing anything else, so nothing is lost if a later step fails.
- Reads simple commands at the start of a message:
  - `/push` saves the text exactly as written, with no cleanup.
  - `/reason` cleans the note up and makes its reasoning explicit.
  - `/think` cleans it up and tightens the thinking.
  - Category tags: `/class`, `/learn`, `/thought`, `/quote`, `/work`, `/project`, `/life`, `/task`, `/deadline`.
  - Tags can be combined with a space: `/push /thought Stay hungry, stay foolish`.
  - `/timezone Asia/Kolkata` sets the timezone used to decide which day an entry belongs to. `/timezone` on its own shows the current one. Older entries keep their day.
  - `/heartbeat` replies with live database counts and writes one heartbeat row, so you can tell a quiet bot from an empty database. It is never saved as an entry.
- Rewrites each note with Workers AI before storing it: filler and false starts out, punctuation and sentence breaks in, and the result laid out to be read (paragraphs, bullets when the note is a list, a little emphasis on the words that carry the point). The original stays in `raw_text` next to the formatted `clean_text`, and the web page's Raw control shows it word for word.
- Commands and empty messages (`/start`, `/heartbeat`, `/timezone`, a bare `/push`, a blank message) are answered and never written to the database.
- Puts untagged text in Inbox for now.
- Sends one summary at 22:00 in the diary's timezone: the day's count and its categories, each note on one line with its hour, and whatever is still open. Two cron entries (`0 20` and `0 21` UTC) cover CET and CEST, the Worker sends only when the local clock has reached 22:00, and a `daily_summary` row in `settings` keeps it to one message a day, so the hour the clocks go back cannot repeat it. A day with nothing written says so rather than skipping the message.
- Ignores duplicate Telegram updates, so a retry never creates a second entry.
- Serves the diary on the web from the same Worker: `public/index.html` plus `public/app.js` read it from `GET /api/entries`, save a typed note through `POST /api/note`, unlock with the passphrase at `/api/session`, and change that passphrase from Settings → Access through `POST /api/passphrase`. The page wears the demo's design: the app and the demo link the same stylesheet, `public/demo/diary.css`.
- Serves a read-only API at `/api/v1`, so other projects of mine can read the diary (by day, month, year, category, type, every deadline, and the counts) with a key minted in Settings → Access. Keys are hashed at rest and revoked one at a time; the API itself is uncached, has no CORS headers, and answers `503` naming the migration until `0007_api_keys.sql` has been run.

## The cleanup step

`src/refine.ts` holds the prompt and the model choice; `src/handler.ts` calls it after the day, category and reminder are worked out and before the row is written.

The model does two jobs in one call: it removes filler, false starts and repetition, and it lays the note out for reading. The markup is deliberately small, because the page renders it and nothing else:

| Written by the model | Shown as |
| --- | --- |
| a blank line between lines | a new paragraph |
| lines starting `- ` | a bullet list |
| lines starting `1. ` | a numbered list |
| `**words**` | **bold** |
| `*words*` | *italic* |
| `==words==` | highlight |

The page escapes every note before rebuilding those markers, so a note can never inject HTML. Headings, tables, code blocks and emoji are explicitly out.

| Note length | Model order |
| --- | --- |
| up to 1000 characters | `@cf/zai-org/glm-4.7-flash`, then `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| longer | `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, then `@cf/zai-org/glm-4.7-flash` |
| last resort, either length | `@cf/meta/llama-3.1-8b-instruct-fp8` |

Each model is tried in turn; an answer that is empty, a lecture, or several times longer than the note is rejected and the next model gets a go. If all three fail, the note is stored as written and the reply says why.

### What the labels mean

- **Refined / Reason / Think** — the note went through the cleanup and came back different, so the Raw control is offered and shows the exact words that were sent.
- **Verbatim** — either `/push` was used, or the cleanup found nothing to change. There is nothing behind a Raw control in that case, so it is not shown.
- A note is never lost and never silently rewritten: `raw_text` always holds what was typed.

Both are in the current catalog. Workers AI retired eighteen older models on 30 May 2026, including `@cf/meta/llama-3.1-8b-instruct`, and a retired id fails only at runtime: check [the catalog](https://developers.cloudflare.com/workers-ai/models/) before changing these.

- `/push` (verbatim) never reaches the model: those words are the point.
- If every model fails, the note is stored as written and the Telegram reply says `Cleanup failed (<reason>), saved as written.` Nothing is ever lost, the reason is in the message, and it is also kept on the capture (`captures.last_error`) so it can be read back without the phone.
- The binding is declared in `wrangler.toml` (`[ai] binding = "AI"`). Local `wrangler dev` cannot run it; Workers AI always runs remotely, so cleanup can only be tested after a deploy.
- `GET /api/ai-check` runs one tiny inference per cleanup model and answers `{ ok, binding, models: [{ model, ok, ms, output | error }] }`. It separates a missing binding from a retired model id from an account that cannot use Workers AI, without writing a test note into the diary.
- `POST /api/note/move` files a note under another category for good: `{ id, category, due? }` writes the row's `category` with `category_source='manual'`, so the sheet says "Moved by you" and the move survives a reload on every device. Moving to `deadline` needs a date and schedules the same T-3 reminder the composer would (rescheduling the one already there instead of adding a second), and moving away deletes that reminder, which takes the due badge with it.
- `POST /api/reclean` re-runs the cleanup over notes an earlier, broken model left untouched (`clean_text` identical to `raw_text`). It only ever rewrites `clean_text`, never `raw_text`, so a bad rewrite is recoverable. It accepts either the Telegram webhook secret or the database service key in an `x-reclean-token` header, and `?limit=` caps the work (default 5, maximum 25) because the call is synchronous.
- `/reclean` in Telegram does the same thing without a token, since the bot already knows it is you: `/reclean 10` repairs ten notes and replies with the count. That is the command to run once after a cleanup-model change; nothing else needs it.

The reply is always three lines: where it was filed, what the cleanup did, and the start of what was stored (first 180 characters, cut with `...`).

```
Saved to Work.
Formatted, 233 -> 127 characters.
The deploy went out, but **Raw** is still missing on the old notes: they predate the cleanup. I keep forgetting that order matters.
```

Line two is one of `Formatted, <before> -> <after> characters.`, `Cleaned up, no change needed.`, `Saved as written, no cleanup.` for `/push`, or `Cleanup failed (<reason>), saved as written.`

## The API

`/api/v1` is how another project reads the diary. It is read-only, it is a separate door from the page's passphrase, and every answer is a JSON envelope.

### Keys

Settings → Access mints one per project. A key looks like `ddk_live_…` (52 characters) and is shown **once**: the database keeps only its SHA-256 beside a 16-character lookup prefix, so there is nothing to read back. Give each project its own key and set its limits as you create it, so a leak exposes only that slice; revoking a key takes effect on its next request.

A key also carries a **policy**, stored beside its scopes and enforced on every read:

| Limit | Effect |
| --- | --- |
| `categories` | the only categories it may read; a request that names another is `403 out_of_policy` |
| `from` / `to` | the earliest and latest day it may read; a wider period is clamped to the window, and a note outside it is `404` |
| `text` | `clean` reads the sentences; `none` answers counts, days, categories and word counts with no `text` field, refuses `q=` and `fields=text`, and cannot export |

The defaults are every category, any day and full text, which is what every key did before limits existed. A note outside a key's policy does not exist as far as that key is concerned (`404`, never `403`), the day and count rollups are narrowed to the policy's categories and window, and a deadline whose note is outside it is hidden or `404` as well.

| Scope | Reads |
| --- | --- |
| `notes:read` | notes, one note, the category list, exports |
| `deadlines:read` | deadlines, one deadline |
| `stats:read` | the per-day rollup and the grouped counts |
| `raw:read` | the original text, next to `notes:read`, and only when a request asks for `raw` |

`notes`, `deadlines` and `stats` are on every new key. `raw:read` is not: the original is the part of a note the cleanup was meant to replace, so it is granted deliberately.

```sh
curl -s "https://<site>/api/v1/notes?month=2026-10&category=work" \
  -H "Authorization: Bearer ddk_live_…"
```

A request without a valid key is `401`, and the answer never says whether the key was unknown, revoked or expired. A valid key without the scope an endpoint needs is `403`, naming the scope; one reaching past its policy is `403 out_of_policy`, naming the category, because a silently empty list would hide the misconfiguration.

### Endpoints

| Endpoint | Scope | Answers |
| --- | --- | --- |
| `GET /api/v1` | — | the API describing itself (no note content) |
| `GET /api/v1/me` | — | this key: name, scopes, `policy` (categories, from, to, text), rate limits, last use |
| `GET /api/v1/notes` | `notes:read` | notes, filtered and paged |
| `GET /api/v1/notes/{id}` | `notes:read` | one note |
| `GET /api/v1/days` | `stats:read` | per day: notes, words, category tally, first and last hour |
| `GET /api/v1/stats` | `stats:read` | grouped counts, `by=day\|week\|month\|year\|category\|type\|source` |
| `GET /api/v1/deadlines` | `deadlines:read` | open, done or all, with `daysLeft`, `daysLate`, `openDays` and the note behind each |
| `GET /api/v1/deadlines/{id}` | `deadlines:read` | one deadline |
| `GET /api/v1/categories` | `notes:read` | id, label, order |
| `GET /api/v1/export` | `notes:read` | a range as `json`, `csv` or `md` |

### Filters on `/notes`

| Parameter | Meaning |
| --- | --- |
| `day=2026-10-25`, `month=2026-10`, `year=2026` | one time selector, never two |
| `from=2026-01-01&to=2026-10-31` | an explicit range; either end may stand alone |
| `category=work,life` | one or more of the diary's categories |
| `type=refined,verbatim,reason,think` | what the note went through |
| `source=tag,auto,manual` | filed by hand or by the classifier |
| `q=proposal` | a word search over the cleaned text (two characters or more, sixty at most) |
| `has=deadline`, `done=true\|false` | notes that carry a deadline, or only the closed/open ones |
| `fields=id,day,text` | cut the shape down; naming `raw` returns the original text, and needs `raw:read` |
| `limit=100&cursor=…` | keyset paging; `meta.next` is the next cursor, or null |
| `order=asc\|desc` | newest first by default |

`/days`, `/stats` and `/export` take the same time selectors. `/deadlines` takes `status=open|done|all`, `due_before`, `due_after` and `limit`.

A note comes back as `{ id, day, time, at, category, type, source, text, words, due?, done?, doneAt?, usage?, raw? }`. `day` and `time` are the diary's local day and clock (`DIARY_TZ`), `at` is the stored timestamp, and `words` is counted from the cleaned text. The envelope is `{ ok, meta: { version, timeZone, count, next }, … }`.

### What the transport guarantees

- Every answer carries `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`, so neither Cloudflare's edge nor a proxy keeps a page of notes.
- No CORS header is ever sent: a web page on another origin cannot read a response even if a key is pasted into it. Server-to-server calls are unaffected.
- Nothing the caller sends reaches a query unfiltered. Each value is checked against a shape (a real date, a known category, a known type) and the PostgREST query is rebuilt server-side. There is no endpoint that proxies the database.
- Only the method, path, status, row count and key prefix are ever logged. Never a note, never a query value, never the caller's address.
- Each key is limited to 60 requests a minute and 5,000 a day by default. Every answer carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; a spent allowance answers `429` with `Retry-After`. The counter is one atomic Postgres function, so a burst cannot slip past a read-then-write race.

## What is not built yet

- Automatic categorization with an LLM: untagged notes still go to Inbox.
- Speech-to-text for voice notes, and photo capture.
- Moving entries between categories on the web.
- Link capture.
- Anything that reads patterns or writes summaries.

## Deployments and branches

- `main` is the only branch that deploys. A push to `main` builds the Worker and the web app; nothing else reaches the live diary.
- Work happens on a short-lived branch per change (`fix/raw-tag`, `feat/reclean`), merged into `main` by pull request.
- Cloudflare Workers Builds still tries to build every pushed branch, and those preview builds fail because they have no production secrets. Turn that off in the dashboard: **Workers & Pages → awedityasdiary → Settings → Build → Branch control → Build production branch only**. Failed preview builds are not a problem with the code.
- The demo in `public/demo/` is published to GitHub Pages from `main` only, by `.github/workflows/pages-demo.yml`.
- Titles: the live site's tab reads **Digital Diary**; the demo reads **Preview · Digital Diary**, so a screenshot always says which one it is.

## Stack

- **Cloudflare Workers:** the Telegram webhook, the API, and the web interface.
- **Supabase (Postgres):** all entries, categories, and the audit trail of changes.
- **Telegram Bot API:** the input channel.
- **TypeScript and Vitest:** the code and its tests.

## Project layout

```
src/            Worker code: webhook entry point, update handler, command parser
test/           Tests for the parser and the handler
migrations/     Database schema, applied in order in the Supabase SQL editor
public/         The web app served by the Worker: index.html, app.js, logo/
public/demo/    Sample-data preview and diary.css, the stylesheet both pages link
wrangler.toml   Worker configuration (name, routes, cron, timezone)
```

## Running the tests

```
npm install
npm run typecheck
npm test
```

`npm install` may need `--legacy-peer-deps` if the Wrangler and types packages report a version conflict. The project already sets this in `.npmrc`.

`npm run dev` runs the Worker on `:8787` against the real Supabase project, but Wrangler's `[ai]` binding is remote by default and wants `wrangler login`. `npm run dev:local` stays entirely local (AI calls answer "not supported") and needs nothing.

## Configuration

Every value lives in exactly one of two places. There is no third file, and no name appears in both.

| File | Holds | Read by |
| --- | --- | --- |
| `wrangler.toml` `[vars]` | non-secret values, committed | `wrangler dev` and every deploy |
| `.dev.vars` | secrets, gitignored | `wrangler dev` and `scripts/*.mjs` |

A secret must also exist on the deployed Worker, because Cloudflare does not read `.dev.vars`. Keeping the two in step is one command:

```sh
npm run secret SUPABASE_SERVICE_KEY   # silent prompt, writes .dev.vars AND pushes to Cloudflare
npm run env:check                     # lists every name, its home, and what is missing
npm run bindings:check                # diffs the DEPLOYED Worker against wrangler.toml
```

`env:check` is about this checkout. `bindings:check` is about the live Worker: it reads the deployed version's binding list from Cloudflare and compares it with `wrangler.toml` — every `[vars]` value present and equal, every required secret present *as a secret*, the `AI` and `ASSETS` bindings attached, and the compatibility date not older than the config. It exits 0 in step, 1 on drift, 2 when it cannot check. Reading the bindings needs **Workers Scripts: Read** on `CLOUDFLARE_API_TOKEN`; an analytics-only token answers 403 and the command says which permission to add.

The prompt never echoes. Pushing to Cloudflare is attempted with the same `CLOUDFLARE_API_TOKEN` everything else uses; `npm run secret NAME -- --local` writes only the local file. Pushing needs that token to carry **Workers Scripts: Edit** — an analytics-only token is refused, and the command says so, leaving the value in `.dev.vars` for one paste in the dashboard (Workers → awedityasdiary → Settings → Variables and Secrets).

| Name | Home | On Cloudflare? | What it is |
| --- | --- | --- | --- |
| `SUPABASE_URL` | `[vars]` | via deploy | Project URL |
| `ALLOWED_CHAT_ID` | `[vars]` | via deploy | Numeric Telegram chat ID of the owner |
| `DIARY_TZ` | `[vars]` | via deploy | Fallback timezone; the value saved with `/timezone` wins |
| `OWNER_USER_ID` | `[vars]` | via deploy | Supabase Auth user that owns every row |
| `CLOUDFLARE_ACCOUNT_ID` | `[vars]` | via deploy | Account the Worker and its analytics belong to |
| `SUPABASE_SERVICE_KEY` | `.dev.vars` | yes | Supabase `service_role` key; bypasses RLS, server only |
| `TELEGRAM_BOT_TOKEN` | `.dev.vars` | yes | Token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | `.dev.vars` | yes | Random string Telegram sends with each update |
| `DIARY_PASSPHRASE` | `.dev.vars` | yes | Interim page lock; removed when Supabase Auth ships |
| `SUPABASE_ANON_KEY` | `.dev.vars` | when auth ships | Public key the Worker uses for the sign-in endpoint |
| `CLOUDFLARE_API_TOKEN` | `.dev.vars` | **no** | Account Analytics: Read + Workers Scripts: Read, for `scripts/` only |
| `DIARY_SESSION_SECRET` | `.dev.vars` | optional | Overrides the cookie signing key; defaults to `DIARY_PASSPHRASE` |

### The web page's door (optional)

The page is **open by default**: with no `DIARY_PASSPHRASE` secret, `GET /api/entries` serves the diary to anyone who has the URL, and no sign-in card appears. To lock it, set the secret with `npm run secret DIARY_PASSPHRASE` (and push it, or paste it in the dashboard).

If local and Cloudflare disagree, the page answers 401 to the passphrase that works locally: Cloudflare's copy wins in production, so the two must match. `npm run env:check` cannot see Cloudflare's values, which is why the same command writes both.

From then on the page shows a sign-in card: `POST /api/session` with `{"passphrase":"..."}` sets an HttpOnly, 30-day signed cookie and `DELETE /api/session` clears it. Removing the secret opens the page again, unless a passphrase has been saved from Settings.

**Changing the passphrase.** Settings → Access changes it without the dashboard: `POST /api/passphrase` with `{"current":"...","next":"..."}` checks the current passphrase, requires eight characters, and stores a PBKDF2-SHA-256 hash in `settings` under the key `passphrase` (so there is no migration to run). The env secret is the seed: while no hash exists it is the passphrase, and once one is saved the hash wins. Both still count as "locked", so the page stays closed even if `DIARY_PASSPHRASE` is later removed. The cookie is signed with the stored hash, so a change signs out every other device and hands the browser that made it a fresh 30-day cookie. Because the hash wins, a forgotten passphrase is not recovered by changing the env secret: delete the row (`delete from settings where key = 'passphrase';` in the Supabase SQL editor) and `DIARY_PASSPHRASE` opens the page again, after which Settings can save a new one.

## Database setup

Open the Supabase SQL editor and run each file in `migrations/` in order: `0001_init.sql`, `0002_settings.sql`, `0003_row_level_security.sql`, `0004_service_role_grants.sql`, `0005_reminders.sql`, `0006_usage.sql`, `0007_api_keys.sql`, `0008_key_policy.sql`. Every one is safe to run again.

`0007` is what the API needs: `api_keys` (one row per key, hash and prefix only), `api_usage` (the rate-limit counters), and the three functions the newer reads go through (`bump_api_usage`, `diary_stats`, `diary_days`). Until it has been run, `/api/v1` answers `503` naming the file, and Settings → Access says the same; the rest of the diary is unaffected.

`0008` adds `api_keys.policy` and gives `diary_stats` and `diary_days` a `p_categories` argument, so a limited key cannot count its way around its limit. Until it has been run, a key with limits answers `403 policy` rather than reading more than it should; the defaults keep every existing key open.

## Contributing

This is a personal project, and it is not open to outside contributions yet. Issues and suggestions are welcome.
