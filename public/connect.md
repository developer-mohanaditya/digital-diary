# Connecting an agent to INK

INK is a private diary at `https://ink.aweditya.com`. This page is the whole setup: put the key
where your tool reads it, check it, install the commands, file one note, and report what the diary
answered.

Version v2, 2 November 2026. If something here fails in a way this page does not explain, say so
plainly rather than working around it.

## The key you were given

A **write key**, shaped `ddk_live_` followed by 43 characters. It can file notes and nothing else:
it cannot read a single note back, so it is safe to leave in a config file or a shell profile.
Three rules, and they are not negotiable:

- **Never print it.** Not in a reply, a log line, a commit, a note, or a message to anyone. If you
  must confirm which key you hold, quote its first 16 characters and an ellipsis; the diary already
  shows the owner that prefix.
- **Store it where the tool reads it**: `DIARY_API_KEY` in the environment, or the `env` block of the
  client's own config. If you write it to a file, it goes in `.env`, and `.env` stays gitignored.
- **Never commit it**, and never copy it into a project file that is tracked.

The note the diary files is stamped with **the key's own name**, not with anything you send. A key
called `Codex` files every note as `codex`, and the diary says *via Codex*. There is nothing to set.

## Step 1: put the key where your tool reads it

Pick the tool you are running in. Every block launches the same server, `mcp/diary.mjs` from
[digital-diary](https://github.com/developer-mohanaditya/digital-diary), which is dependency-free
and speaks both the current and the older MCP protocol revisions.

**Claude Code**

```sh
claude mcp add --transport stdio --scope user diary \
  --env DIARY_API_KEY=ddk_live_YOUR_KEY \
  -- npx -y github:developer-mohanaditya/digital-diary ink-mcp
```

**Codex**: `~/.codex/config.toml`

```toml
[mcp_servers.diary]
command = "npx"
args = ["-y", "github:developer-mohanaditya/digital-diary", "ink-mcp"]

[mcp_servers.diary.env]
DIARY_API_KEY = "ddk_live_YOUR_KEY"
```

**Cursor**: `.cursor/mcp.json`, the same JSON shape Claude Code uses

```json
{
  "mcpServers": {
    "diary": {
      "command": "npx",
      "args": ["-y", "github:developer-mohanaditya/digital-diary", "ink-mcp"],
      "env": { "DIARY_API_KEY": "ddk_live_YOUR_KEY" }
    }
  }
}
```

**No MCP, or a sandbox that cannot spawn a process**: use the API directly, with the key in
`DIARY_API_KEY`. Nothing to install.

```sh
curl -s https://ink.aweditya.com/api/v1/me -H "Authorization: Bearer $DIARY_API_KEY"
```

## Step 2: check the key before trusting it

Call `diary_whoami`, or `GET /api/v1/me`. It answers with the key's name, its scopes, its rate
limits and its policy: which categories it may file into, which dates it may date a note, and
whether it may read text at all.

Read the answer, and repeat it back to the owner: the name, and the policy in words. A write key
with a policy narrower than the work ahead is a refusal waiting to happen, and it is better to know
now.

## Step 3: file one note

Call `diary_add_notes` with exactly one note, then check the receipt:

```json
{ "notes": [ { "text": "Connected from Codex. The write path works.", "category": "inbox" } ],
  "idempotencyKey": "codex-connect-2026-11-02" }
```

Without MCP, the same request:

```sh
curl -s -X POST https://ink.aweditya.com/api/v1/notes \
  -H "Authorization: Bearer $DIARY_API_KEY" \
  -H "Idempotency-Key: codex-connect-2026-11-02" \
  -d '{"notes":[{"text":"Connected from Codex. The write path works.","category":"inbox"}]}'
```

An answer looks like this: `200`, one receipt, `status: "stored"`, and `telegram: "sent"` because
the owner was told on their phone at the same moment.

```json
{ "ok": true,
  "meta": { "version": "v1", "timeZone": "Europe/Paris", "count": 1 },
  "receipt": { "code": "rc_9f1a20", "duplicate": false,
    "notes": [ { "id": "…", "day": "2026-11-02", "category": "inbox", "mode": "refine",
                 "status": "stored", "cleanup": "formatted", "words": 7, "error": null } ],
    "counts": { "notes": 1, "words": 7, "byCategory": { "inbox": 1 } },
    "telegram": "sent" } }
```

## Step 4: install the commands

`/ink` is the skill, and the menu carries it as one entry. The named commands are files, so the menu
only lists the ones that exist on this machine: without them, `/ink-` finds nothing even though
`/ink` works. Install all 59, flat. `~/.claude/commands/ink-brief.md` becomes `/ink-brief`, while
the same file under `~/.claude/commands/ink/` would be namespaced and would never answer to the
name you type.

```sh
mkdir -p ~/.claude/commands
curl -fsS https://ink.aweditya.com/commands/names.txt | while read -r name; do
  curl -fsS "https://ink.aweditya.com/commands/$name.md" -o "$HOME/.claude/commands/$name.md"
done
ls "$HOME"/.claude/commands/ink-*.md | wc -l
```

The last line answers 59. Codex reads `~/.codex/prompts/` instead, with the same loop and that
directory in place of `~/.claude/commands`. Codex writes its own namespace in front of every file it
finds there, so in Codex the same commands are `/prompts:ink-brief` and `/prompts:ink-update`. The
prefix belongs to the app, not to the file, and the command behind it is identical. Copy only the
`ink-` files: `names.txt` is the list the loop reads, not a command, and a stray file in that folder
shows up in the menu as one.

The menu is built when a session starts, so a new session is what makes `/ink-` complete after
this. The skill's own presets still work without the wrappers, as in `/ink note project the grid is
generated`, so a tool with no commands folder is not locked out, only unsuggested.

### Updating later

The files on this machine are snapshots, so an edit to the skill or to a wrapper reaches a tool
only when it is fetched again. `/ink-update`, which is `/prompts:ink-update` in Codex, does that: it
refetches both, in each of the two
folders it knows, and removes any wrapper the list no longer names. Without the skill, the same
loop by hand, with `~/.codex/prompts` in place of `~/.claude/commands` for Codex:

```sh
base=https://ink.aweditya.com/commands
curl -fsS "$base/names.txt" | while read -r name; do
  curl -fsS "$base/$name.md" -o "$HOME/.claude/commands/$name.md"
done
```

A new session is what rebuilds the menu, so `/ink-` starts completing after one.

## Step 5: tell the owner what happened

Report the receipt: how many notes, under which categories, the receipt code, and whether Telegram
was sent. If a note failed, say which one and why. Do not round a partial write up to "done". Then
stop. One note is enough to prove the pipe; do not write a second one to be sure.

## Invoking it later

Setup happens once, and afterwards there is one command per shape:

```
/ink          one note, and the agent picks the depth
/ink-brief    one or two sentences
/ink-note     three to eight sentences
/ink-detail   two to four paragraphs, with the decision and the blocker
/ink-guide    a written-up method, stored verbatim
/ink-threads  one note per separate line of work
/ink-split    one note per distinct decision or topic
/ink-update   refetches the skill and the wrappers, writes nothing
```

Each takes the subject after it, as in `/ink-brief the deploy broke`. The longer form works too,
`/ink threads brief`, because the skill reads presets from the words after the command. In Codex
every one of these carries the app's namespace, `/prompts:ink-brief the deploy broke`, for the reason
in step 4.

`/ink-update` is the one command that is not a shape: it refetches this skill and the wrappers, as
Step 4 describes.

`/ink` on its own is the quick door: one note, a line or two, for a phrase worth keeping. Every
category and depth pair has a name too, `/ink-work`, `/ink-note-project`, `/ink-guide-learning`,
following `/ink-<depth>-<category>` with the depth left out meaning `brief`.

Category and mode are the agent's call, from what the note is about and from the depth, unless the
command names them: `cat:life` picks the shelf, `mode:verbatim` keeps the words exactly, and
`due:2026-11-06` dates a deadline, as in `/ink-note cat:deadline due:2026-11-06 renew the domain`.

The skill is served at <https://ink.aweditya.com/skills/ink/SKILL.md>, and the wrappers at
<https://ink.aweditya.com/commands/>, which is what Step 4 installs. Both also sit in the diary's
repository, for reading rather than for copying by hand.

Tell the owner this once the key works, because it is the part he will actually type.

## Writing notes this diary keeps

How many notes a session should become, and how long each one runs, is the skill's job:
[`skills/ink/SKILL.md`](/skills/ink/SKILL.md). This section is what the API accepts,
so the two agree on the fields and the markup.

The diary is where the owner keeps what he thought, decided and did, in his own voice, so he can
remember the day in a year. It is not a changelog and not a status report.

- First person, his voice: "I shipped…", "I decided…", "I still do not know…".
- What changed and what it means; what he decided and why; what is blocked or still open.
- Keep every fact, name, number, date, path and quotation exactly as it is. Invent nothing, and
  leave out anything you did not actually do.
- Three to eight sentences for one entry. When a session covered distinct topics, one short
  paragraph per topic, each in its own note.
- No preamble ("Here is your diary entry"), no advice he did not ask for, no closing summary.

### The markup it renders

The page escapes every note and then rebuilds exactly these markers. Anything else shows up as
literal characters, so do not reach for more.

| Write | It renders as |
| --- | --- |
| a blank line between lines | a new paragraph |
| a line starting `- ` | a bullet list |
| a line starting `1. ` | a numbered list |
| `**words**` | **bold**, at most three per note |
| `*words*` | *italic* |
| `==words==` | highlight, for a date or deadline not to forget, at most two |

No headings, no tables, no code fences, no emoji, no links: the page shows those as the characters
you typed. Send text, not a document. A short note about one thing is one plain paragraph with no
markup at all. The skill has a table for what to send instead of each, under "The input is text, not
a document".

### The fields

| Field | Meaning |
| --- | --- |
| `text` | required; up to 4,000 characters |
| `category` | `class`, `learning`, `thought`, `quote`, `work`, `project`, `life`, `task`, `deadline`, `inbox` (the default) |
| `mode` | `refine` formats it for you (the default), `verbatim` stores the words exactly, `reason` makes the reasoning explicit, `think` tightens the thinking |
| `day` | `YYYY-MM-DD`; today in the diary's timezone unless the session belongs to another day |
| `at` | ISO timestamp for when the work happened; its local day must match `day` |
| `due` | `YYYY-MM-DD`, on a `deadline` note only; schedules the reminder |
| `idempotencyKey` | stable for one session. The same key twice files nothing and returns the first receipt, so a retry is always safe |

Use `verbatim` when the prose above is already what should be stored: your own summary, or words
the owner dictated. Use `refine` when you are handing over raw notes for the diary to format.

A session is one request: up to 25 notes, 40,000 characters in total. A batch is not all-or-nothing;
the receipt says per note what happened, and a retry with the same `idempotencyKey` skips whatever
already landed.

## When it is refused

| Answer | Meaning | What to do |
| --- | --- | --- |
| `401` | the key is unknown, revoked or expired | stop; ask the owner for a new one |
| `403 out_of_policy` | the note is outside this key's categories or dates | report the limit by name; never retry with another category to get around it |
| `403` naming a scope | the key lacks `notes:write` | it is a read key; ask for a write key |
| `403 policy` | the diary is mid-migration | tell the owner which migration the message names |
| `429` | the allowance is spent | wait for `Retry-After`; do not retry in a loop |
| `502` | some notes failed | the receipt says which, and why, per note |
| `503 setup` | this build cannot file notes | tell the owner; nothing you can change |

Two things not to do, ever: try to read the diary (a write key cannot, and that refusal is the
point), and file anything the owner would not want written down. No tokens, no passwords, no
private keys, no other people's secrets.

## Done

The note is in the diary, the owner has the receipt on Telegram, and this page can be dropped from
your context. From now on, when a session is worth remembering, file it.
