-- What the cleanup actually cost, per note.
--
-- Workers AI reports the tokens it billed on the response, and the note is the only place
-- they can be recorded: the reply is seen once and the capture row is about the raw text.
-- All three columns are nullable on purpose. A verbatim note never reaches a model, an
-- older note predates this column, and not every model reports usage at all — and a zero
-- would read as "this note was free", which is a lie the dashboard would then draw.
alter table thoughts
  add column if not exists tokens_in integer,
  add column if not exists tokens_out integer,
  add column if not exists cleanup_model text;
