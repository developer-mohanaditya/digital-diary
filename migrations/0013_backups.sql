-- A weekly snapshot of everything the diary would be sorry to lose.
--
-- The notes live in one Supabase project with no export of their own. A wrong delete (there has
-- already been one, when the test notes were cleared), a migration that rewrites a column, or a
-- bad key rotation has had nothing behind it. This takes a full copy of the content once a week
-- and keeps the last twelve, so the most that can ever be lost is seven days.
--
-- What is copied: the notes, the captures they came from (raw text, origin, status), the
-- reminders, and the archive that 0011 shelved. Not the API keys or the settings — a backup is
-- for the diary, and copying a passphrase hash into another table only widens where it lives.
--
-- The snapshot is JSONB inside the same database, not an export to somewhere else: it undoes
-- mistakes in the data, not the loss of the project. Mistakes in the data are the failure this
-- diary actually has.
--
-- Restoring is additive on purpose. diary_restore() puts back rows that are missing and touches
-- nothing that is there; it never deletes and never overwrites. A restore that removed rows would
-- be a second way to lose a note, which is the thing this file exists to prevent.

create table if not exists diary_backups (
  id bigserial primary key,
  taken_at timestamptz not null default now(),
  reason text not null default 'scheduled',
  counts jsonb not null,
  payload jsonb not null
);

comment on table diary_backups is
  'Weekly JSONB snapshot of the diary content, written by diary_backup() on a pg_cron schedule.';

-- Every note in the diary is in this table, so nothing but the service role may read it: RLS on
-- with no policies, and the public roles are stripped of the grants Supabase hands out by
-- default. The functions below are security definer for the same reason.
alter table diary_backups enable row level security;
revoke all on diary_backups from anon, authenticated;

-- The content, as one JSONB document. Ordering is by the time the row was made, so a restored
-- set reads back in the same order a day page draws it.
create or replace function diary_snapshot() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'captures', coalesce((select jsonb_agg(to_jsonb(c) order by c.received_at, c.id) from captures c), '[]'::jsonb),
    'thoughts', coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at, t.id) from thoughts t), '[]'::jsonb),
    'reminders', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from reminders r), '[]'::jsonb),
    'archived_notes', coalesce((select jsonb_agg(to_jsonb(a) order by a.archived_at, a.id) from archived_notes a), '[]'::jsonb)
  );
$$;

-- Take one snapshot and drop anything past the retention limit. The counts are written beside the
-- payload so a glance at the table says whether a backup is real or an empty shell.
create or replace function diary_backup(p_reason text default 'scheduled', p_keep integer default 12)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_payload jsonb := diary_snapshot();
  v_id bigint;
  v_keep integer := greatest(coalesce(p_keep, 12), 1);
begin
  insert into diary_backups (reason, counts, payload)
  values (
    coalesce(p_reason, 'scheduled'),
    jsonb_build_object(
      'thoughts', jsonb_array_length(v_payload->'thoughts'),
      'captures', jsonb_array_length(v_payload->'captures'),
      'reminders', jsonb_array_length(v_payload->'reminders'),
      'archived_notes', jsonb_array_length(v_payload->'archived_notes')
    ),
    v_payload
  )
  returning id into v_id;

  delete from diary_backups
   where id not in (select id from diary_backups order by taken_at desc, id desc limit v_keep);

  return v_id;
end $$;

-- Put back what a snapshot has and the database no longer does. Captures first, because a note
-- points at its capture; then the notes, then the reminders that point at both. Rows that still
-- exist are skipped by primary key, so running this twice is harmless and running it after a
-- partial delete restores only the gap.
create or replace function diary_restore(p_backup_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_payload jsonb;
  v_captures integer := 0;
  v_thoughts integer := 0;
  v_reminders integer := 0;
  v_archived integer := 0;
  v_found integer := 0;
begin
  select payload, jsonb_array_length(payload->'thoughts')
    into v_payload, v_found
    from diary_backups where id = p_backup_id;

  if v_payload is null then
    raise exception 'no backup with id %', p_backup_id;
  end if;

  insert into captures
    select * from jsonb_populate_recordset(null::captures, v_payload->'captures')
    on conflict (id) do nothing;
  get diagnostics v_captures = row_count;

  insert into thoughts
    select * from jsonb_populate_recordset(null::thoughts, v_payload->'thoughts')
    on conflict (id) do nothing;
  get diagnostics v_thoughts = row_count;

  insert into reminders
    select * from jsonb_populate_recordset(null::reminders, v_payload->'reminders')
    on conflict (id) do nothing;
  get diagnostics v_reminders = row_count;

  insert into archived_notes
    select * from jsonb_populate_recordset(null::archived_notes, v_payload->'archived_notes')
    on conflict (id) do nothing;
  get diagnostics v_archived = row_count;

  return jsonb_build_object(
    'backup', p_backup_id,
    'restored', jsonb_build_object(
      'captures', v_captures, 'thoughts', v_thoughts,
      'reminders', v_reminders, 'archived_notes', v_archived
    ),
    'note', 'Only missing rows were written; nothing present was changed.'
  );
end $$;

-- The schedule. Monday 03:00 UTC — after the Sunday-evening notes and before the Monday morning
-- ones, and at an hour when nobody is waiting on the database. pg_cron is a Supabase-supported
-- extension but is not guaranteed to be installed, so both the extension and the job are
-- optional here: without them the functions above still work, called by hand.
do $$
begin
  begin
    execute 'create extension if not exists pg_cron';
  exception when others then
    raise notice 'pg_cron could not be installed (%) — the backup functions are still usable by hand.', sqlerrm;
  end;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- cron.schedule is idempotent by job name: re-running this file re-points the same job
    -- instead of adding a second one.
    perform cron.schedule('diary-weekly-backup', '0 3 * * 1', 'select public.diary_backup(''scheduled'')');
  else
    raise notice 'pg_cron is not installed: nothing schedules the weekly backup yet.';
  end if;
end $$;

-- The backup functions write and delete rows; only the service role may call them.
revoke execute on function diary_snapshot() from public, anon, authenticated;
revoke execute on function diary_backup(text, integer) from public, anon, authenticated;
revoke execute on function diary_restore(bigint) from public, anon, authenticated;
