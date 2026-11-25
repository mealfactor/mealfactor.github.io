-- Groceries can be ticked off (and unticked) instead of being deleted straight away.
alter table public.groceries add column if not exists checked boolean not null default false;
