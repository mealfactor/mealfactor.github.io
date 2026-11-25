-- Macros per serving (grams) on each regular. Optional; entries and votes read them via dish_id.
alter table public.dishes add column if not exists carbs_g   numeric check (carbs_g   >= 0);
alter table public.dishes add column if not exists protein_g numeric check (protein_g >= 0);
alter table public.dishes add column if not exists fat_g     numeric check (fat_g     >= 0);

notify pgrst, 'reload schema';
