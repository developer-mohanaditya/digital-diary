-- Where the notes written while building the diary went.
--
-- Sample notes typed or posted to prove a path works are not the diary. Left in `thoughts`
-- they sit in the timeline, on the day page, in the 10pm summary and behind every API read,
-- so the first real month looks like it was written by nobody. Deleting them outright would
-- throw away the only realistic sample text the project has, so they are moved here instead:
-- the same rows, verbatim, reachable by hand and by nothing the app runs.
--
-- Nothing reads this table at runtime. It is a shelf: a fixture for a future test or demo, and
-- the way back (`insert into thoughts select (thought->>...)::... from archived_notes` keeps
-- the ids, so a restore is exact). The capture's whole row is kept beside the thought's,
-- because the raw text and the Telegram update id are what a re-import would need.
--
-- Safe to run again: the move is guarded by the note ids it names, `on conflict` skips a row
-- already on the shelf, and the deletes only touch what was just archived. Six notes are
-- deliberately absent from that list — the ones written by hand on 23, 25 and 26 October.

create table if not exists archived_notes (
  id          uuid primary key,            -- the thought's own id, so a restore is exact
  day         date not null,
  captured_at timestamptz not null,
  category    text not null,
  source      text not null,               -- telegram | web | api
  client      text,
  clean_text  text not null,
  thought     jsonb not null,              -- the whole thought row, as it stood
  capture     jsonb not null,              -- the whole capture row, as it stood
  archived_at timestamptz not null default now(),
  reason      text not null default 'sample data written while building the diary'
);
create index if not exists archived_notes_day_idx on archived_notes (day);

-- The 23 notes: the 22 sent to the bot while testing plus the one filed by the write API,
-- between 13 and 26 October.
insert into archived_notes (id, day, captured_at, category, source, client, clean_text, thought, capture)
select t.id, t.day, t.captured_at, t.category, c.source, c.client, t.clean_text,
       to_jsonb(t), to_jsonb(c)
  from thoughts t
  join captures c on c.id = t.capture_id
 where t.id in (
   '466ea514-1ce8-4fc5-9ab3-4bc2d03261dd',  -- "Hello diary. Test."
   'fb08bf8f-eab0-4b69-ac63-1e604f933485',  -- "Had a coffee with Ram."
   '9623ac99-5d3f-436e-af1c-9d3483349b36',
   '299ca882-9ace-41c0-a188-14fe1bcbf602',
   'df8cd9cb-443d-4975-b9ce-5590ad65880f',
   '5c94f6ba-0c65-40a0-b149-0e559ad9a46e',
   '1dde9b04-17ed-4a3f-b5d1-b1d1275dbea7',
   '943a13b2-14bf-43c1-862f-e91fbf538c38',
   'd8e92164-0414-49c0-a30f-f6182912e1ce',
   '7968c27f-848d-450b-bcb0-63fb6fc24e5d',
   'af8456c4-c884-458f-9e5f-75f75275d5fb',  -- the ClearRoute deadline note and its reminder
   'cf2ebb2b-e290-4a69-ae7a-75163eab5550',
   '2a617581-5c45-4d01-b3a2-8f34b35d2b04',
   '99712488-e076-47bd-b53f-e47b27a3b5b7',
   '1daea694-8ce6-4d1a-8346-599a5983a5aa',
   'c933e562-855c-4ada-82c1-b9121090f1a5',
   'a5653f03-e12a-4e91-9015-e4aa7bbe1c3d',  -- posted to the webhook by a script
   'd656ccde-4225-4de9-885c-ba7b707cb3c2',
   'c6b77ac6-f4c0-4da1-9590-37794fc53150',
   '3a98bb34-6973-48bc-85f1-2223072535aa',  -- the one note typed on the page while testing
   '9691a909-72c5-4ee6-9955-e9eced94242f',
   '7f0dc538-34dd-4d2e-bd59-d667e50b0055',  -- filed through POST /api/v1/notes
   'ab8355cd-a54d-45a9-8c62-d64d4860193e'   -- the webhook check after the move to ink.aweditya.com
 )
on conflict (id) do nothing;

-- The deadline that note carried, and then the notes themselves. A reminder has to go before
-- its thought does: `reminders.thought_id` references it.
delete from reminders where capture_id in (
  'd764c6f6-344e-4f87-9559-c72632fcccd6', '994ee39b-1b1c-4ba5-ba13-27aac601b171',
  'beb975f3-13f1-45f8-966c-b325ed4803ab', '6630937b-d5db-4f4a-8e5b-a0fe8a8c2151',
  '3513c3e8-cf69-46be-ab8c-d3063c8ff8d0', '1540599f-4d7e-4fce-b401-620da59e4fa1',
  '09777c42-e929-468c-ae0d-6923264a71a9', '4b2a65d9-35f3-41bf-b88f-723bac87efce',
  'a5e76f84-17d2-469b-a796-b9f1fa232ec8', '09b4ff6f-52b7-47ab-ae2b-32da28052be5',
  '78042390-ad25-4551-ab17-75d34bc85f35', '006321a7-74c7-464a-8c1c-0923c270ff6b',
  '8391d093-0014-4e48-b6ac-8f344cd58bf0', 'e2a64ed3-89fd-4464-b6f2-1f4ae20219d4',
  'd17da462-9d35-4121-a0cf-da5b938155ba', 'b932d508-66c3-4c63-a0a7-2c017725ad6f',
  '4e2563d2-9c9c-4063-9433-d917c24382d2', '25d6535b-9328-4604-8d43-f13a87092e5f',
  'bdb64b90-edc1-4519-9faa-c5f72939df10', '6e87c480-8c73-4556-98c9-4c07f13a834d',
  '76b577a3-8fc7-41cf-ab6a-75c7c7716c2c', '03f764ff-51ad-4581-b563-a4ac5444873c',
  '1f95152f-2528-4235-98d6-8d0f901fbea2', '99d3cc81-8e6d-4d4f-8576-996b91db5785'
);

delete from thoughts where id in (
  '466ea514-1ce8-4fc5-9ab3-4bc2d03261dd', 'fb08bf8f-eab0-4b69-ac63-1e604f933485',
  '9623ac99-5d3f-436e-af1c-9d3483349b36', '299ca882-9ace-41c0-a188-14fe1bcbf602',
  'df8cd9cb-443d-4975-b9ce-5590ad65880f', '5c94f6ba-0c65-40a0-b149-0e559ad9a46e',
  '1dde9b04-17ed-4a3f-b5d1-b1d1275dbea7', '943a13b2-14bf-43c1-862f-e91fbf538c38',
  'd8e92164-0414-49c0-a30f-f6182912e1ce', '7968c27f-848d-450b-bcb0-63fb6fc24e5d',
  'af8456c4-c884-458f-9e5f-75f75275d5fb', 'cf2ebb2b-e290-4a69-ae7a-75163eab5550',
  '2a617581-5c45-4d01-b3a2-8f34b35d2b04', '99712488-e076-47bd-b53f-e47b27a3b5b7',
  '1daea694-8ce6-4d1a-8346-599a5983a5aa', 'c933e562-855c-4ada-82c1-b9121090f1a5',
  'a5653f03-e12a-4e91-9015-e4aa7bbe1c3d', 'd656ccde-4225-4de9-885c-ba7b707cb3c2',
  'c6b77ac6-f4c0-4da1-9590-37794fc53150', '3a98bb34-6973-48bc-85f1-2223072535aa',
  '9691a909-72c5-4ee6-9955-e9eced94242f', '7f0dc538-34dd-4d2e-bd59-d667e50b0055',
  'ab8355cd-a54d-45a9-8c62-d64d4860193e'
);

-- The captures those notes arrived in, and only those: the two `/push` and `/project` commands
-- from 23 October failed before they became a note, and they stay as the record that they did.
delete from captures c
 where c.id in (
   'd764c6f6-344e-4f87-9559-c72632fcccd6', '994ee39b-1b1c-4ba5-ba13-27aac601b171',
   'beb975f3-13f1-45f8-966c-b325ed4803ab', '6630937b-d5db-4f4a-8e5b-a0fe8a8c2151',
   '3513c3e8-cf69-46be-ab8c-d3063c8ff8d0', '1540599f-4d7e-4fce-b401-620da59e4fa1',
   '09777c42-e929-468c-ae0d-6923264a71a9', '4b2a65d9-35f3-41bf-b88f-723bac87efce',
   'a5e76f84-17d2-469b-a796-b9f1fa232ec8', '09b4ff6f-52b7-47ab-ae2b-32da28052be5',
   '78042390-ad25-4551-ab17-75d34bc85f35', '006321a7-74c7-464a-8c1c-0923c270ff6b',
   '8391d093-0014-4e48-b6ac-8f344cd58bf0', 'e2a64ed3-89fd-4464-b6f2-1f4ae20219d4',
   'd17da462-9d35-4121-a0cf-da5b938155ba', 'b932d508-66c3-4c63-a0a7-2c017725ad6f',
   '4e2563d2-9c9c-4063-9433-d917c24382d2', '25d6535b-9328-4604-8d43-f13a87092e5f',
   'bdb64b90-edc1-4519-9faa-c5f72939df10', '6e87c480-8c73-4556-98c9-4c07f13a834d',
   '76b577a3-8fc7-41cf-ab6a-75c7c7716c2c', '03f764ff-51ad-4581-b563-a4ac5444873c',
   '1f95152f-2528-4235-98d6-8d0f901fbea2', '99d3cc81-8e6d-4d4f-8576-996b91db5785'
 )
   and not exists (select 1 from thoughts t where t.capture_id = c.id);

-- Same lockdown as every other table: RLS on, no public policies, service_role only.
alter table archived_notes enable row level security;
grant select, insert, update, delete on archived_notes to service_role;
