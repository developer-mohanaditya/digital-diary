-- Small key/value settings. The timezone decides which day a new entry belongs to.
-- Changing it affects only entries saved afterwards; old entries keep their day.

create table if not exists settings (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

insert into settings (key, value) values ('timezone', 'Europe/Paris')
on conflict (key) do nothing;
