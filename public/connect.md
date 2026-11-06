# Connecting an agent to INK

INK is a private diary at `https://ink.aweditya.com`. This page is the whole setup: put the key
where your tool reads it, check it, install the commands, file one note, and report what the diary
answered.

Version v3, 2 November 2026. If something here fails in a way this page does not explain, say so
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

/ink is the skill, and the menu carries it as one entry. The named commands do too: every one of them
lives inside /ink/references/commands.md, and typing any ink- name still starts the same skill. There are
59 of them. Install the skill once, then update the local command list so the menu can list all 59 names
the same way the tool does. The loop below is the same shape Codex uses for its single-skill install: one
folder, one SKILL.md, one references file, and a names file the loop reads so the menu lists all 59.

   sh
mkdir -p "$HOME/.claude/skills"
base=https://ink.aweditya.com
curl -fsS "$base/commands/names.txt" -o "$HOME/.claude/skills/ink-names.txt"
curl -fsS "$base/skills/ink/SKILL.md" -o "$HOME/.claude/skills/ink/SKILL.md"
curl -fsS "$base/skills/ink/references/commands.md" -o "$HOME/.claude/skills/ink/references/commands.md"
ls "$HOME"/.claude/skills/ink/SKILL.md && echo "ink skill installed"
ls "$HOME"/.claude/skills/ink/references/commands.md && echo "ink command list installed (59 names)"

The last two lines answer yes and 59. The names live inside the skill now, so /ink-brief, /ink-note,
/ink-detail, /ink-guide, /ink-threads, /ink-split and every /ink-<depth>-<category> name and the bare
/ink all start the same skill, with the right preset already described for each.

**Codex.** It removed custom prompt files in 0.117, so ~/.codex/prompts/ no longer answers anything, whatever
sits in it. There each command is a skill, so the same install is one folder too, with the same names file so
the menu lists all 59. Name the folder ink, keep SKILL.md beside the references file, and list ink-names.txt in
~/.codex/skills/ so the menu shows every command.

   sh
mkdir -p "$HOME/.codex/skills/ink"
base=https://ink.aweditya.com
curl -fsS "$base/skills/ink/SKILL.md" -o "$HOME/.codex/skills/ink/SKILL.md"
curl -fsS "$base/skills/ink/references/commands.md" -o "$HOME/.codex/skills/ink/references/commands.md"
curl -fsS "$base/commands/names.txt" -o "$HOME/.codex/skills/ink-names.txt"
ls "$HOME"/.codex/skills/ink/SKILL.md && echo "ink skill installed in Codex"
cat "$HOME"/.codex/skills/ink-names.txt | wc -l && echo "command names listed for the menu"

The last line answers 59. In Codex the commands are skills, so each is invoked by mentioning it: $ink-brief,
$ink-update, $ink-brief-work, and a bare $ or /skills lists them all. The words after the mention are the
subject, as in $ink-brief the deploy broke. Install only the ink skill; the names file is what lets the menu
list the 59 names, not a second install.

**Freebuff and any other agent or project.** The same install, in ~/.agents/skills/ink/ if that is where the
tool reads skills, or wherever its skill folder is. One folder, one SKILL.md, one references file, one names
file, and the menu lists all 59 names. The skill's own presets still work without the wrappers, as in /ink note
project the grid is generated, so a tool with no command list is not locked out, only unable to list the 59 names.

The menu is built when a session starts, so a new session is what makes the /ink- names appear after this. A
build that reads ~/.agents/skills instead of ~/.claude/skills or ~/.codex/skills takes the same install into that
folder; the names file is what tells it there are 59 commands to list, not 59 folders.

### Updating later

The files on this machine are snapshots, so an edit to the skill or to the command list reaches a tool only when
it is fetched again. /ink-update, which is $ink-update in Codex, does that: it refetches the skill, the command
list and the 59 names into the folder it finds, and removes any name the list no longer carries. Without the skill,
the Claude Code loop by hand, into the same folder as above:

   sh
base=https://ink.aweditya.com
mkdir -p "$HOME/.claude/skills/ink/references"
curl -fsS "$base/skills/ink/SKILL.md" -o "$HOME/.claude/skills/ink/SKILL.md"
curl -fsS "$base/skills/ink/references/commands.md" -o "$HOME/.claude/skills/ink/references/commands.md"
curl -fsS "$base/commands/names.txt" -o "$HOME/.claude/skills/ink-names.txt"
ls "$HOME"/.claude/skills/ink/SKILL.md && echo "skill refreshed"
cat "$HOME"/.claude/skills/ink-names.txt | wc -l && echo "names refreshed"

A new session is what rebuilds the menu, so /ink- starts completing after one.

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
every one of these is a skill, so the same command is `$ink-brief the deploy broke`, for the reason
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
