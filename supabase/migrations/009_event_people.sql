-- Tag events and to-dos with family member names (stored as a simple list).
-- The names themselves live in households.settings.people (no table needed).
alter table family_events add column if not exists people text[] default null;
alter table family_tasks  add column if not exists people text[] default null;
