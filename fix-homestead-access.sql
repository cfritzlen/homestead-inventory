-- Gives a Supabase user full homestead access (stops the bounce to Family Hub).
-- Run in Supabase → SQL Editor. Replace the email on the last line, then Run.
-- Safe to run more than once.
insert into public.household_members (household_id, user_id, email, role, can_access_homestead)
select h.id, u.id, u.email, 'owner', true
from auth.users u
cross join (select id from public.households where name = 'Our Family' limit 1) h
where lower(u.email) = lower('YOUR-EMAIL-HERE')
on conflict (household_id, user_id)
do update set can_access_homestead = true, role = 'owner';
