# Digital Diary

A personal diary that I write to from Telegram, and read on the web.

I used to write a journal at night, about what I did, learned, and thought that day. Writing it by hand took time, and I rarely kept it up. This project makes that quicker: I send a message (text or, later, a voice note) to a Telegram bot, and it lands in the right day, in the right category, with the original kept.

The longer goal is to keep a record of how I change over time: habits, projects, what I learn, and how my thinking shifts. The diary is the first step. Patterns and reflections come after I have a few months of data.

## What it does today

- Receives text from a Telegram bot, and only from my own chat.
- Stores every message as a raw capture before doing anything else, so nothing is lost if a later step fails.
- Reads simple commands at the start of a message:
  - `/push` saves the text exactly as written, with no cleanup.
  - `/reason` marks a messy idea that should be structured.
  - `/think` marks a thought for deeper analysis.
  - Category tags: `/class`, `/learn`, `/thought`, `/quote`, `/work`, `/project`, `/life`, `/task`.
  - Tags can be combined with a space: `/push /thought Stay hungry, stay foolish`.
  - `/timezone Asia/Kolkata` sets the timezone used to decide which day an entry belongs to. `/timezone` on its own shows the current one. Older entries keep their day.
- Puts untagged text in Inbox for now.
- Ignores duplicate Telegram updates, so a retry never creates a second entry.
- Serves a web interface from the same Worker (currently a preview with sample data, see `demo/`).

## What is not built yet

- Automatic cleanup and categorization with an LLM.
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
public/         Web interface served by the Worker
demo/           A standalone copy of the interface with sample data
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

## Database setup

Open the Supabase SQL editor and run each file in `migrations/` in order (`0001_init.sql`, then `0002_settings.sql`, then `0003_row_level_security.sql`). Both are safe to run again.

## Contributing

This is a personal project, and it is not open to outside contributions yet. Issues and suggestions are welcome.
