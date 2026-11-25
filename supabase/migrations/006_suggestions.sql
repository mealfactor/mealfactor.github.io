-- "It's been a while": snooze a regular, note its ingredients, and know when a grocery was bought.
alter table public.dishes    add column if not exists snoozed_until date;
alter table public.dishes    add column if not exists ingredients   text;
alter table public.groceries add column if not exists checked_at    timestamptz;

notify pgrst, 'reload schema';
