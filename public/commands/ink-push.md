---
description: Send the reviewed .ink/draft.md to the diary in one request
argument-hint: [nothing]
---

Use the `ink` skill, phase two. Read `.ink/draft.md` and send exactly what is in it: one request,
one idempotency key from the `key:` line, the day from the `day:` line.

Do not rewrite the prose, reorder the notes, add an entry or change a category. The file is the
reviewed copy.

If the file is missing, empty or incomplete, say what is wrong and send nothing.

After a successful send, report the receipt and move the file to `.ink/sent/<day>-<key>.md`.
