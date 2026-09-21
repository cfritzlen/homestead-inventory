-- One-time sweep of the review queue ("waiting for you"):
--   1. proposed events that already happened -> rejected
--   2. proposed events that repeat another event on the same day -> rejected
--      (keeps the earliest copy; approved copies win over proposed ones)
--   3. proposed to-dos that repeat another open/proposed to-do -> rejected
-- Titles are compared with punctuation and case removed. The hub does a
-- looser word-overlap pass on top of this every time the list opens.
-- Safe to re-run.

create or replace function public.__norm_title(t text) returns text
language sql immutable as $$
  select regexp_replace(lower(coalesce(t, '')), '[^a-z0-9]+', ' ', 'g')
$$;

-- 1. past events
update public.family_events
   set status = 'rejected'
 where status = 'proposed'
   and coalesce(ends_at, starts_at) < (now() - interval '1 day');

-- 2. duplicate events on the same day
with ranked as (
  select id,
         row_number() over (
           partition by household_id, (starts_at at time zone 'America/New_York')::date, public.__norm_title(title)
           order by (status = 'approved') desc, created_at
         ) as rn
    from public.family_events
   where status in ('proposed', 'approved')
)
update public.family_events e
   set status = 'rejected'
  from ranked r
 where e.id = r.id and r.rn > 1 and e.status = 'proposed';

-- 3. duplicate to-dos
with ranked as (
  select id,
         row_number() over (
           partition by household_id, public.__norm_title(title)
           order by (status = 'open') desc, created_at
         ) as rn
    from public.family_tasks
   where status in ('proposed', 'open')
)
update public.family_tasks t
   set status = 'rejected'
  from ranked r
 where t.id = r.id and r.rn > 1 and t.status = 'proposed';

drop function public.__norm_title(text);
