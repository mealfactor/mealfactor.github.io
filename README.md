# mealfactor 🍲

A tiny web app for two people sharing a kitchen:

- **🗳️ Vote**: suggest meals (🏠 home or 🍽️ out), both vote 👍/👎, then pick the winner. Votes show up live on both phones.
  A **Today** card shows what you've eaten so far, with macro totals.
- **💭 It's been a while**: suggestions from your regulars, one tap to add to the vote or log as eaten.
  - Each meal is judged by its own rhythm (median gap between eats), falling back to 14 days until it has history.
  - Meals that use groceries you've already bought (ticked) come first, matched by name or the meal's ingredients.
  - 💤 *Not now* hides a meal for a week (with Undo); filter by Home / Out; 🎲 *Surprise me* picks from the top three.
  - Meals usually eaten at another time of day sink down the list.
- **📅 Calendar**: a month view of what you ate. Picking a vote winner logs it automatically, or add meals to any day by hand from a dropdown of your regulars (or a new one). Each day shows its C / P / F and calories, and a week summary adds a daily breakdown, the week's total with the C / P / F split, and the daily average.
- **⭐ Regulars**: two lists, things you make at home and things you eat out (with the place), each showing when you last had it.
  ✎ edit sets the name, place, ingredients, and macros (carbs, protein, fat in grams per serving; calories are worked out at 4/4/9 kcal per gram). Each calendar entry keeps the macros from the day it was logged, so editing a meal later doesn't change your history.
- **🍳 Meals**: a table of every home-cooked meal with editable C / P / F (grams per serving), calories updating as you type, and a Save button on each row. Add a new meal with its macros at the top; tap a meal's name to rename it or edit its ingredients. The household name, join code and members are behind the link at the bottom.
- **🧺 Groceries**: add what you need, tick items off as you buy them (with Undo), and clear the ticked ones.

Username and password login. It's a static site on GitHub Pages, at https://mealfactor.github.io, with data stored in [Supabase](https://supabase.com) (free tier).

## Privacy

The code is public, but your data isn't. Every table uses Postgres row-level security
([`supabase/schema.sql`](supabase/schema.sql)), so a signed-in user can only read or write rows
that belong to their own household. The Supabase *publishable key* in `config.js` is designed to be public.
**Never** commit a secret or `service_role` key.

## One-time setup (about 5 minutes)

1. Create a free project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query**, paste all of `supabase/schema.sql`, then click **Run**.
   (Existing databases: run the files in `supabase/migrations/` you haven't yet; the latest is `007_eaten_macros.sql`.)
3. **Authentication → Sign In / Providers → Email**: turn **off** “Confirm email”. Usernames are mapped
   to pseudo-emails, so no mail can be delivered.
4. **Project Settings → API**: copy the **Project URL** (Settings → Data API) and the **publishable** key (Settings → API Keys) into `config.js`, then commit and push.
5. Open the site, **Sign up** with a username and password, then **Create** a household.
   Go to the 🏠 tab and send the join code to your partner. They sign up and **Join** with that code.
6. Optional but recommended: once you've both signed up, go to **Authentication → Sign In / Providers**
   and turn off **Allow new users to sign up**.

## Tests

```sh
npm install        # once; only installs playwright-core (uses your installed Chrome)
npm test           # unit + UI tests
npm run test:unit  # just the logic in lib.js (dates, suggestions, scoring, calendar, macros)
npm run test:ui    # clicks through the real page in headless Chrome at phone sizes
```

- `tests/unit/` tests the pure helpers in `lib.js` with Node's built-in test runner.
- `tests/ui/` drives `index.html` with Playwright against `tests/ui/fake-supabase.js`, an
  in-memory stand-in that mirrors the database rules, so no real data is touched.
- `tests/db/db_test.sql` checks row-level security and the one-regular-everywhere rules on the
  real database. Paste it into the Supabase SQL Editor and run it: it rolls itself back and
  reports PASS/FAIL per check in the error message.

GitHub Actions runs the unit and UI tests on every push.

## Local dev

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000.
