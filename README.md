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
  - `/test` replies with live database counts and writes one heartbeat row, so you can tell a quiet bot from an empty database. It is never saved as an entry.
- Cleans each note up with Workers AI before storing it: filler and false starts out, punctuation and sentence breaks in, the writer's facts and voice untouched. The original stays in `raw_text` next to the cleaned `clean_text`, and the web page's Raw control shows it.
- Puts untagged text in Inbox for now.
- Ignores duplicate Telegram updates, so a retry never creates a second entry.
- Serves the diary on the web from the same Worker: `public/index.html` plus `public/app.js` read it from `GET /api/entries`. The page is open unless a passphrase secret is set.

## The cleanup step

`src/refine.ts` holds the prompt and the model choice; `src/handler.ts` calls it after the day, category and reminder are worked out and before the row is written.

| Note length | Model |
| --- | --- |
| up to 1000 characters | `@cf/zai-org/glm-4.7-flash` |
| longer | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |

Both are in the current catalog. Workers AI retired eighteen older models on 30 May 2026, including `@cf/meta/llama-3.1-8b-instruct`, and a retired id fails only at runtime: check [the catalog](https://developers.cloudflare.com/workers-ai/models/) before changing these.

- `/push` (verbatim) never reaches the model: those words are the point.
- If the model fails or answers with nothing, the note is stored as written and the Telegram reply says `Cleanup failed (<reason>), so it is saved exactly as you wrote it.` Nothing is ever lost, and the reason is in the message instead of only in the Worker logs.
- The binding is declared in `wrangler.toml` (`[ai] binding = "AI"`). Local `wrangler dev` cannot run it; Workers AI always runs remotely, so cleanup can only be tested after a deploy.

The reply is always three lines: where it was filed, what the cleanup did, and the start of what was stored (first 180 characters, cut with `...`).

```
Saved to Work.
Cleaned up, 233 -> 127 characters.
The deploy went out, but Raw is still missing on the old notes: they predate the cleanup. I keep forgetting that order matters.
```

Line two is one of `Cleaned up, <before> -> <after> characters.`, `Cleaned up, no change needed.`, `Saved as written, no cleanup.` for `/push`, or `Cleanup failed (<reason>), saved as written.`

## What is not built yet

- Automatic categorization with an LLM: untagged notes still go to Inbox.
- Speech-to-text for voice notes, and photo capture.
- Moving entries between categories on the web.
- Link capture.
- Anything that reads patterns or writes summaries.

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
public/demo/    Sample-data preview, kept for design work
wrangler.toml   Worker configuration (name, routes, cron, timezone)
```

## Running the tests

```
npm install
npm run typecheck
npm test
```

`npm install` may need `--legacy-peer-deps` if the Wrangler and types packages report a version conflict. The project already sets this in `.npmrc`.

## Configuration

Secrets are never stored in this repository. They live in Cloudflare (Worker settings) or in a local `.dev.vars` file that is ignored by Git.

| Name | Type | What it is |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | secret | Token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | secret | Random string that Telegram sends with each update |
| `SUPABASE_SERVICE_KEY` | secret | Supabase `service_role` key, used only by the Worker |
| `SUPABASE_URL` | variable | Supabase project URL |
| `ALLOWED_CHAT_ID` | variable | Numeric Telegram chat ID of the owner |
| `DIARY_TZ` | variable | Fallback timezone, used only if none is stored. The stored value (set with `/timezone`) wins |
| `DIARY_PASSPHRASE` | secret, optional | When set, the diary page asks for it. When absent, the page is open |
| `DIARY_SESSION_SECRET` | secret, optional | Signs the login cookie. Defaults to `DIARY_PASSPHRASE` |

### The web page's door (optional)

The page is **open by default**: with no `DIARY_PASSPHRASE` secret, `GET /api/entries` serves the diary to anyone who has the URL, and no sign-in card appears. To lock it later, set the secret once:

```sh
npx wrangler secret put DIARY_PASSPHRASE
```

From then on the page shows a sign-in card: `POST /api/session` with `{"passphrase":"..."}` sets an HttpOnly, 30-day signed cookie and `DELETE /api/session` clears it. Removing the secret opens the page again. Cloudflare Access also works if it is added: the Worker accepts its `Cf-Access-Jwt-Assertion` header as a signed-in visitor.

## Database setup

Open the Supabase SQL editor and run each file in `migrations/` in order (`0001_init.sql`, then `0002_settings.sql`, then `0003_row_level_security.sql`, then `0004_service_role_grants.sql`). All four are safe to run again.

## Contributing

This is a personal project, and it is not open to outside contributions yet. Issues and suggestions are welcome.
