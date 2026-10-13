-- Digital Diary: first schema.
-- Raw captures are append-only: never update or delete rows here.

create table if not exists categories (
  id          text primary key,            -- class | learning | thought | quote | work | project | life | task | inbox
  label       text not null,
  sort_order  int  not null
);

insert into categories (id, label, sort_order) values
  ('class', 'Class', 1), ('learning', 'Learning', 2), ('thought', 'Thought', 3),
  ('quote', 'Quote', 4), ('work', 'Work', 5), ('project', 'Project', 6),
  ('life', 'Life', 7), ('task', 'Task', 8), ('inbox', 'Inbox', 9)
on conflict (id) do nothing;

-- Everything received from Telegram, stored before any processing.
create table if not exists captures (
  id                 uuid primary key default gen_random_uuid(),
  source             text not null default 'telegram',
  source_update_id   bigint not null,       -- Telegram update_id, used for idempotency
  source_chat_id     bigint not null,
  kind               text not null check (kind in ('text', 'voice', 'photo', 'link')),
  raw_text           text,                   -- exactly what was typed or transcribed
  media_path         text,                   -- Supabase Storage path for voice/photo
  command_mode       text check (command_mode in ('refine', 'verbatim', 'reason', 'think')),
  command_category   text references categories(id),
  status             text not null default 'received'
                       check (status in ('received', 'processing', 'done', 'failed', 'awaiting_category')),
  attempts           int  not null default 0,
  last_error         text,
  received_at        timestamptz not null default now(),
  unique (source, source_update_id)
);

-- Refined, categorized entries shown in the diary.
create table if not exists thoughts (
  id               uuid primary key default gen_random_uuid(),
  capture_id       uuid not null references captures(id),
  day              date not null,           -- local day of capture
  captured_at      timestamptz not null,
  category         text not null references categories(id),
  category_source  text not null check (category_source in ('tag', 'auto', 'manual')),
  mode             text not null check (mode in ('refine', 'verbatim', 'reason', 'think')),
  clean_text       text not null,          -- shown in the diary
  raw_text         text not null,          -- kept forever, for reprocessing and training
  reasoning        text,                   -- /reason and /think output, if any
  created_at       timestamptz not null default now()
);
create index if not exists thoughts_day_idx on thoughts (day);
create index if not exists thoughts_category_idx on thoughts (category, day);

-- Every manual move between categories, kept as an audit trail.
create table if not exists category_changes (
  id            uuid primary key default gen_random_uuid(),
  thought_id    uuid not null references thoughts(id),
  from_category text not null references categories(id),
  to_category   text not null references categories(id),
  changed_at    timestamptz not null default now()
);

create table if not exists links (
  id           uuid primary key default gen_random_uuid(),
  capture_id   uuid not null references captures(id),
  url          text not null,
  title        text,
  description  text,
  created_at   timestamptz not null default now()
);

-- Daily heartbeat written by the scheduled function, to keep the free project active.
create table if not exists heartbeats (
  id          bigint generated always as identity primary key,
  beat_at     timestamptz not null default now(),
  note        text
);
