# Agent notes

## Commits: no agent attribution

Every commit in this repository is authored by the repository owner, and nothing else. Do not
add `Co-Authored-By:` trailers for an agent, a tool or a service, and do not add
`Generated with …` footers, emoji or otherwise. Commit messages describe the change and stop
there.

A `commit-msg` hook enforces this in `.githooks/commit-msg`; enable it in a fresh clone with
`git config core.hooksPath .githooks`. The hook strips attribution lines rather than blocking
the commit, so a message that still carries one will silently lose that line.

## Prose: no em-dashes

No em-dashes anywhere in this repository: not in prose, not in code comments, not in UI copy, not
in commit messages, not in anything the Worker sends. Use a comma, a colon, a full stop or
parentheses instead. A plain hyphen between spaces is not a substitute, because it reads as the
same mannerism in a different costume.

## `/impeccable`: design skill

The Impeccable design skill (v4.7.0) lives at `.agents/skills/impeccable`. When the user
writes `/impeccable` or `/impeccable <subcommand> …`, read
[`.agents/skills/impeccable/SKILL.md`](.agents/skills/impeccable/SKILL.md) in full and
follow it; it owns the workflow, the modes and the quality floor for that turn.

Every session that uses it starts here, with the cwd at the project root:

```sh
.agents/skills/impeccable/scripts/impeccable context
```

That loads `PRODUCT.md`, `DESIGN.md`, any surface brief and native guidance, and says what
is missing. Follow its directives and do not run it twice. Add `--target <path>` to scope
it to one file or route. Then load the subcommand's playbook from
`.agents/skills/impeccable/reference/`, and read `reference/craft-floor.md` immediately
before the first UI edit.

Subcommands: `init`, `document`, `extract`, `live`, `generate`, `adapt`, `animate`,
`audit`, `bolder`, `clarify`, `colorize`, `critique`, `delight`, `distill`, `harden`,
`onboard`, `layout`, `optimize`, `overdrive`, `polish`, `quieter`, `shape`, `typeset`,
`craft`.

The launcher is a self-contained binary, so nothing needs installing to use it. The
binaries in `.agents/skills/impeccable/scripts/bin/` are platform-specific and git-ignored;
they are re-downloaded on demand.

Without a subcommand the skill decides from the request: narrowing an existing surface
(`polish`, `critique`, `typeset`…) preserves the incumbent look, while a new surface or a
redesign goes through `init`/`shape` first.

## This project's design truth

The served app is everything the Worker serves: `public/index.html`, `public/app.js` and
`public/diary.css`, the shell, the day page, the month and dashboard, the sheets and the Look
page. The sample-data demo that used to answer at `/demo/` is gone, so there is exactly one
copy of the interface and nothing to keep in step with it. `src/`, the Telegram handler and
the migrations are backend and are out of scope for design work.

Before changing how anything looks, run it (`npm run dev`) and look at the rendered result
at the sizes it ships at, narrow phone width included. The tokens live in
`public/diary.css`, the one stylesheet the app links: ink, paper, accent, the offset
shadow, the heavy 2px edge. Purple is the accent; nothing else may compete with it.
