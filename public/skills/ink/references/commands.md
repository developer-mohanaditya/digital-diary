# INK commands, the whole list

Generated from `commands/manifest.json` by `scripts/sync-skill.mjs`. Edit the generator, not
this file.

59 commands, and every one is a preset of the `ink` skill: a unit, a depth and
sometimes a category, settled before the session is read, so the same words reach the same shape
every time. Read this when he names a command you cannot place, or asks what one is for. The
rules they all follow (how many notes, how deep, the markup, the request, the receipt) are in
`../SKILL.md`, and this file only says which preset a name stands for.

| Command | Unit | Depth | Category | Mode | What it does |
| --- | --- | --- | --- | --- | --- |
| `/ink-brief` | one | brief | - | refine | a line or two, category from the session |
| `/ink-brief-class` | one | brief | class | refine | a line or two about class |
| `/ink-brief-deadline` | one | brief | deadline | refine | a line or two about deadline |
| `/ink-brief-inbox` | one | brief | inbox | refine | a line or two about inbox |
| `/ink-brief-learning` | one | brief | learning | refine | a line or two about learning |
| `/ink-brief-life` | one | brief | life | refine | a line or two about life |
| `/ink-brief-project` | one | brief | project | refine | a line or two about project |
| `/ink-brief-quote` | one | brief | quote | refine | a line or two about quote |
| `/ink-brief-task` | one | brief | task | refine | a line or two about task |
| `/ink-brief-thought` | one | brief | thought | refine | a line or two about thought |
| `/ink-brief-work` | one | brief | work | refine | a line or two about work |
| `/ink-class` | one | brief | class | refine | a line or two about class |
| `/ink-deadline` | one | brief | deadline | refine | a line or two about deadline, asks for due: |
| `/ink-detail` | one | detail | - | refine | a few paragraphs, with the decision and the blocker, category from the session |
| `/ink-detail-class` | one | detail | class | refine | a few paragraphs, with the decision and the blocker about class |
| `/ink-detail-deadline` | one | detail | deadline | refine | a few paragraphs, with the decision and the blocker about deadline |
| `/ink-detail-inbox` | one | detail | inbox | refine | a few paragraphs, with the decision and the blocker about inbox |
| `/ink-detail-learning` | one | detail | learning | refine | a few paragraphs, with the decision and the blocker about learning |
| `/ink-detail-life` | one | detail | life | refine | a few paragraphs, with the decision and the blocker about life |
| `/ink-detail-project` | one | detail | project | refine | a few paragraphs, with the decision and the blocker about project |
| `/ink-detail-quote` | one | detail | quote | refine | a few paragraphs, with the decision and the blocker about quote |
| `/ink-detail-task` | one | detail | task | refine | a few paragraphs, with the decision and the blocker about task |
| `/ink-detail-thought` | one | detail | thought | refine | a few paragraphs, with the decision and the blocker about thought |
| `/ink-detail-work` | one | detail | work | refine | a few paragraphs, with the decision and the blocker about work |
| `/ink-draft` | draft | - | - | - | drafts the session into .ink/draft.md, revises on request, sends nothing |
| `/ink-guide` | one | guide | - | verbatim | a written-up method, category from the session |
| `/ink-guide-class` | one | guide | class | verbatim | a written-up method about class |
| `/ink-guide-deadline` | one | guide | deadline | verbatim | a written-up method about deadline |
| `/ink-guide-inbox` | one | guide | inbox | verbatim | a written-up method about inbox |
| `/ink-guide-learning` | one | guide | learning | verbatim | a written-up method about learning |
| `/ink-guide-life` | one | guide | life | verbatim | a written-up method about life |
| `/ink-guide-project` | one | guide | project | verbatim | a written-up method about project |
| `/ink-guide-quote` | one | guide | quote | verbatim | a written-up method about quote |
| `/ink-guide-task` | one | guide | task | verbatim | a written-up method about task |
| `/ink-guide-thought` | one | guide | thought | verbatim | a written-up method about thought |
| `/ink-guide-work` | one | guide | work | verbatim | a written-up method about work |
| `/ink-inbox` | one | brief | inbox | refine | a line or two about inbox |
| `/ink-learning` | one | brief | learning | refine | a line or two about learning |
| `/ink-life` | one | brief | life | refine | a line or two about life |
| `/ink-note` | one | note | - | refine | a short paragraph or two, category from the session |
| `/ink-note-class` | one | note | class | refine | a short paragraph or two about class |
| `/ink-note-deadline` | one | note | deadline | refine | a short paragraph or two about deadline |
| `/ink-note-inbox` | one | note | inbox | refine | a short paragraph or two about inbox |
| `/ink-note-learning` | one | note | learning | refine | a short paragraph or two about learning |
| `/ink-note-life` | one | note | life | refine | a short paragraph or two about life |
| `/ink-note-project` | one | note | project | refine | a short paragraph or two about project |
| `/ink-note-quote` | one | note | quote | refine | a short paragraph or two about quote |
| `/ink-note-task` | one | note | task | refine | a short paragraph or two about task |
| `/ink-note-thought` | one | note | thought | refine | a short paragraph or two about thought |
| `/ink-note-work` | one | note | work | refine | a short paragraph or two about work |
| `/ink-project` | one | brief | project | refine | a line or two about project |
| `/ink-push` | push | - | - | - | sends the reviewed draft in one request, then archives it |
| `/ink-quote` | one | brief | quote | refine | a line or two about quote |
| `/ink-split` | split | note | - | refine | one note per distinct decision or topic |
| `/ink-task` | one | brief | task | refine | a line or two about task |
| `/ink-thought` | one | brief | thought | refine | a line or two about thought |
| `/ink-threads` | threads | note | - | refine | one note per separate line of work |
| `/ink-update` | update | - | - | - | refetches the skill and the wrappers, writes nothing |
| `/ink-work` | one | brief | work | refine | a line or two about work |

## When the name is not here

A word he uses that is not one of these names is the subject, not a preset, so it becomes one
note about that subject. A preset he says in words after `/ink`, as in `/ink threads brief`, is
still a preset: read the list for those words, then file as the matching row would.
