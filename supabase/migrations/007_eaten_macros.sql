-- Each calendar entry keeps its own copy of the macros from the day it was logged,
-- so editing a regular's macros later doesn't rewrite history.
alter table public.meals_eaten add column if not exists carbs_g   numeric check (carbs_g   >= 0);
alter table public.meals_eaten add column if not exists protein_g numeric check (protein_g >= 0);
alter table public.meals_eaten add column if not exists fat_g     numeric check (fat_g     >= 0);

-- One-time: existing entries take the regular's current macros.
update public.meals_eaten m
   set carbs_g = d.carbs_g, protein_g = d.protein_g, fat_g = d.fat_g
  from public.dishes d
 where m.dish_id = d.id and m.carbs_g is null and m.protein_g is null and m.fat_g is null;

notify pgrst, 'reload schema';
