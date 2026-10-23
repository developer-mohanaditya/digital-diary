-- Deadlines + reviews: same alert path, different schedules.
-- Deadline: explicit due date, daily pings from T-3 to due date.
-- Review: relative 'later', 1-2 pings with Done button.

insert into categories (id, label, sort_order) values
  ('deadline', 'Deadline', 10)
on conflict (id) do nothing;

create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  capture_id uuid not null references captures(id),
  thought_id uuid references thoughts(id),
  kind text not null check (kind in ('deadline', 'review')),
  title text not null,
  due_at timestamptz,
  next_remind_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'done', 'snoozed')),
  source text not null default 'heuristic'
    check (source in ('explicit', 'heuristic', 'ai')),
  snooze_count int not null default 0,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists reminders_next_idx on reminders (status, next_remind_at);
create index if not exists reminders_thought_idx on reminders (thought_id);

-- Same lockdown as other tables: RLS on, no public policies, service_role only.
alter table reminders enable row level security;
grant select, insert, update, delete on reminders to service_role;
