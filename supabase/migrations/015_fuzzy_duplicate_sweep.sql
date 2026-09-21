-- Sweep duplicates with the same loose title match the hub uses:
-- titles are lower-cased, punctuation and filler words dropped, and two
-- titles count as the same thing when 3/4 of the shorter one's words appear
-- in the other ("2-Hour Delay — Stroudsburg School District" = "SASD 2 Hour
-- Delay"). Events must also be on the same day. Keeps the oldest copy,
-- preferring an approved one; rejected approved copies also come off Google
-- Calendar via the trigger from migration 014. Safe to re-run.

create or replace function public.__title_tokens(t text) returns text[]
language sql immutable as $$
  select coalesce(array_agg(distinct w), '{}'::text[])
    from unnest(regexp_split_to_array(
           regexp_replace(lower(coalesce(t, '')), '[^a-z0-9]+', ' ', 'g'), '\s+')) as w
   where w <> ''
     and w not in ('the','a','an','at','for','to','of','and','with','day','night','nights','event','reminder')
$$;

create or replace function public.__same_thing(a text[], b text[]) returns boolean
language sql immutable as $$
  select case
    when coalesce(cardinality(a), 0) = 0 or coalesce(cardinality(b), 0) = 0 then false
    else (select count(*) from unnest(a) as x where x = any(b))::float
         / least(cardinality(a), cardinality(b)) >= 0.75
  end
$$;

-- Events: one pass per household + local day
do $$
declare
  grp record;
  ev record;
  cur_toks text[];
  dup boolean;
begin
  create temp table kept_titles (toks text[]);
  for grp in
    select household_id, (starts_at at time zone 'America/New_York')::date as d
      from public.family_events
     where status in ('proposed', 'approved')
     group by 1, 2
    having count(*) > 1
  loop
    truncate kept_titles;
    for ev in
      select id, title
        from public.family_events
       where household_id is not distinct from grp.household_id
         and (starts_at at time zone 'America/New_York')::date = grp.d
         and status in ('proposed', 'approved')
       order by (status = 'approved') desc, created_at
    loop
      cur_toks := public.__title_tokens(ev.title);
      select exists (select 1 from kept_titles k where public.__same_thing(k.toks, cur_toks)) into dup;
      if dup then
        update public.family_events set status = 'rejected' where id = ev.id;
      else
        insert into kept_titles values (cur_toks);
      end if;
    end loop;
  end loop;
  drop table kept_titles;
end $$;

-- To-dos: one pass per household (no date)
do $$
declare
  grp record;
  t record;
  cur_toks text[];
  dup boolean;
begin
  create temp table kept_tasks (toks text[]);
  for grp in
    select household_id
      from public.family_tasks
     where status in ('proposed', 'open')
     group by 1
    having count(*) > 1
  loop
    truncate kept_tasks;
    for t in
      select id, title
        from public.family_tasks
       where household_id is not distinct from grp.household_id
         and status in ('proposed', 'open')
       order by (status = 'open') desc, created_at
    loop
      cur_toks := public.__title_tokens(t.title);
      select exists (select 1 from kept_tasks k where public.__same_thing(k.toks, cur_toks)) into dup;
      if dup then
        update public.family_tasks set status = 'rejected' where id = t.id;
      else
        insert into kept_tasks values (cur_toks);
      end if;
    end loop;
  end loop;
  drop table kept_tasks;
end $$;

drop function public.__same_thing(text[], text[]);
drop function public.__title_tokens(text);
