---
description: Write this session's summary into Aweditya's diary
argument-hint: [one note | split | notes: … | deadline <when>: …]
---

File this session into Aweditya's diary as something he will read back later. Not a changelog,
not a status report, not a list of the tools you used: the diary is where he keeps what he
thought, decided and did, in his own voice, so he can remember the day in a year.

## What to write

- First person, his voice: "I shipped…", "I decided…", "I still do not know…".
- What changed and what it means, what he decided and why, what is blocked or still open.
- Keep every fact, name, number, date, path and quotation exactly as it is. Invent nothing, and
  leave out anything you did not actually do in this session.
- Three to eight sentences for one entry. When splitting, one short paragraph per topic.
- No preamble about writing a note ("Here is your diary entry"), no advice he did not ask for,
  no closing summary of what you just wrote.

## How to write it (the markup the diary renders)

The page escapes a note and then rebuilds exactly these markers, so anything else shows up as
literal characters:

| Write | It renders as |
| --- | --- |
| a blank line between lines | a new paragraph |
| a line starting `- ` | a bullet list |
| a line starting `1. ` | a numbered list |
| `**words**` | **bold** — at most three per note |
| `*words*` | *italic* |
| `==words==` | highlight — for a date or deadline not to forget, at most two |

No headings, no tables, no code fences, no emoji. A short note about one thing stays one plain
paragraph with no markup at all.

## What the argument asks for

- `one note` — the whole session as a single entry.
- `split` — one entry per topic, decision or piece of work, each filed under its own category.
- `notes: X; Y; Z` — exactly those lines, one note each, as close to the words given as possible.
- `deadline <when>: …` — a `deadline` note with `due` set to that date.

## Filing it

Call `diary_add_notes` with:

- `client` — the app you are: `claude-code`, `codex`, or similar.
- `idempotencyKey` — one per session and stable, like `claude-code-2026-10-26-write-api`. The same
  key a second time files nothing and returns the first receipt, so a retry is always safe.
- `mode` — `verbatim` when the prose above is already what should be stored, `refine` when the
  diary should format it for you.
- `category` — whichever fits (`work`, `project`, `learning`, `thought`, `life`, `task`, `class`,
  `quote`); `deadline` with `due` for anything dated.

Then tell Aweditya what the receipt says: how many notes were filed, under which categories, the
receipt code, the words the Telegram confirmation carried, and anything that failed. If it is
refused (403), say so plainly and call `diary_whoami` to show which limit the key carries — do not
try again with different categories to get around it.

## If the MCP server is not set up

The same thing over HTTP, with the key in `DIARY_API_KEY`:

```sh
curl -s -X POST "${DIARY_API_URL:-https://ink.aweditya.com}/api/v1/notes" \
  -H "Authorization: Bearer $DIARY_API_KEY" \
  -H "Idempotency-Key: claude-code-$(date +%Y-%m-%d)-session" \
  -d '{"client":"claude-code","notes":[{"text":"…","category":"work"}]}'
```
