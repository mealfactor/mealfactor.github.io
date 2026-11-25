// Pure helpers shared by app.js and the tests. No DOM, no network.

// Regulars not eaten for this many days show up under "It's been a while".
export const STALE_DAYS = 14;
export const STALE_LIMIT = 6; // rows shown before "Show more"
export const SLOT_ORDER = { breakfast: 0, lunch: 1, snack: 2, dinner: 3 };

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const kindIcon = (k) => (k === "out" ? "🍽️" : "🏠");

// Same rule as the database: trim, collapse inner whitespace, ignore case.
export const cleanName = (s) => String(s ?? "").trim().replace(/\s+/g, " ");
export const norm = (s) => cleanName(s).toLowerCase();

// Dates are local calendar days as "YYYY-MM-DD" strings.
export function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
export const firstOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
export const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);

// Whole days from dateStr to today; Math.round absorbs DST's 23/25-hour days.
export function daysAgo(dateStr, today = ymd(new Date())) {
  return Math.round((parseYmd(today) - parseYmd(dateStr)) / 864e5);
}

export function agoText(dateStr, today = ymd(new Date())) {
  if (!dateStr) return "not had yet";
  const n = daysAgo(dateStr, today);
  if (n <= 0) return "today";
  if (n === 1) return "yesterday";
  if (n < 14) return `${n} days ago`;
  if (n < 60) return `${Math.round(n / 7)} weeks ago`;
  if (n < 365) return `${Math.round(n / 30)} months ago`;
  const y = Math.round(n / 365);
  return y === 1 ? "a year ago" : `${y} years ago`;
}

export function slotForHour(h) {
  return h < 11 ? "breakfast" : h < 16 ? "lunch" : "dinner";
}

export const activeDishes = (dishes) => dishes.filter((d) => !d.archived);

export function findDish(dishes, name, kind) {
  const n = norm(name);
  if (!n) return undefined;
  return activeDishes(dishes).find((d) => norm(d.name) === n && (!kind || d.kind === kind));
}

// Most recent day (up to today) a regular was eaten; future entries don't count.
export function lastEaten(eaten, dishId, today = ymd(new Date())) {
  let last = null;
  for (const m of eaten) {
    if (m.dish_id === dishId && m.eaten_on <= today && (!last || m.eaten_on > last)) last = m.eaten_on;
  }
  return last;
}

// Days between eats are each regular's own rhythm: the median gap, once it has
// been eaten 3+ times (clamped to 5-90 days). Fewer eats fall back to STALE_DAYS.
export function usualGap(eaten, dishId, today = ymd(new Date())) {
  const days = [...new Set(eaten.filter((m) => m.dish_id === dishId && m.eaten_on <= today).map((m) => m.eaten_on))].sort();
  if (days.length < 3) return STALE_DAYS;
  const gaps = days.slice(1).map((d, i) => daysAgo(days[i], d)).sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.min(90, Math.max(5, Math.round(median)));
}

// The meal slot a regular is usually eaten in (most common logged slot), or null.
export function usualSlot(eaten, dishId) {
  const n = {};
  for (const m of eaten) if (m.dish_id === dishId && m.slot) n[m.slot] = (n[m.slot] ?? 0) + 1;
  return Object.entries(n).sort((a, b) => b[1] - a[1] || (SLOT_ORDER[a[0]] ?? 9) - (SLOT_ORDER[b[0]] ?? 9))[0]?.[0] ?? null;
}

// Words for matching groceries to meals: lowercase, 3+ letters, plural "s"/"es" dropped.
const STOP = new Set(["and", "the", "with", "fresh", "for", "pack", "packet", "box", "bag"]);
export function words(s) {
  return String(s ?? "").toLowerCase().split(/[^a-z\u00c0-\u024f]+/)
    .map((w) => (w.length > 4 && w.endsWith("es") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

// Ticked groceries (already bought) that a regular uses, by its name or ingredients,
// oldest first, each with how many days ago it was ticked.
export function groceryMatches(dish, groceries, today = ymd(new Date())) {
  const mine = new Set(words(`${dish.name} ${dish.ingredients ?? ""}`));
  return groceries
    .filter((g) => g.checked && words(g.name).some((w) => mine.has(w)))
    .map((g) => ({ name: g.name, age: Math.max(0, daysAgo(ymd(new Date(g.checked_at ?? g.created_at)), today)) }))
    .sort((a, b) => b.age - a.age || a.name.localeCompare(b.name));
}

// "It's been a while": regulars that are overdue by their own rhythm, or that use
// groceries you already bought. Not snoozed. Order: uses food -> in this meal
// slot -> most overdue (days since / usual gap) -> never had (A-Z).
export function suggestions(dishes, eaten, groceries, today = ymd(new Date()), { kind = null, slot = null } = {}) {
  return activeDishes(dishes)
    .filter((d) => (!kind || d.kind === kind) && !(d.snoozed_until && d.snoozed_until > today))
    .map((d) => {
      const last = lastEaten(eaten, d.id, today);
      const typical = usualGap(eaten, d.id, today);
      const since = last ? daysAgo(last, today) : null;
      const usual = usualSlot(eaten, d.id);
      return { d, last, typical, ratio: since == null ? -1 : since / typical, overdue: since == null ? null : since - typical,
        uses: groceryMatches(d, groceries, today), offSlot: !!(slot && usual && usual !== slot) };
    })
    .filter((r) => r.uses.length || r.last == null || r.ratio >= 1)
    .sort((a, b) => (b.uses.length > 0) - (a.uses.length > 0)
      || a.offSlot - b.offSlot
      || (a.uses.length ? b.uses[0].age - a.uses[0].age : 0)
      || (a.ratio === b.ratio ? a.d.name.localeCompare(b.d.name) : b.ratio - a.ratio));
}

// One list per kind: never-had first, then longest-ago, then A–Z.
export function regularsList(dishes, eaten, kind, today = ymd(new Date())) {
  return activeDishes(dishes).filter((d) => d.kind === kind)
    .map((d) => ({ d, last: lastEaten(eaten, d.id, today) }))
    .sort((a, b) => (a.last ?? "").localeCompare(b.last ?? "") || a.d.name.localeCompare(b.d.name));
}

// Vote options with score and my vote, best first; ties go to the earlier suggestion.
export function scoreOptions(options, votes, userId) {
  return options.map((o) => {
    const vs = votes.filter((v) => v.option_id === o.id);
    return { ...o, vs, score: vs.reduce((n, v) => n + v.value, 0), mine: vs.find((v) => v.user_id === userId)?.value ?? 0 };
  }).sort((a, b) => b.score - a.score || String(a.created_at).localeCompare(String(b.created_at)));
}

// Only a positive score leads; nobody wins on zero or negative votes.
export const leader = (scored) => (scored[0] && scored[0].score > 0 ? scored[0] : null);

// Clicking the vote I already cast removes it; otherwise it sets/replaces it.
export const voteAction = (mine, value) => (mine === value ? "remove" : "set");

// Month grid: leading blanks for the weekday offset, then one cell per day.
// Each day's marks follow meal order (breakfast → dinner), like the day list.
export function monthCells(month, eaten) {
  const byDay = groupByDay(eaten);
  const blanks = month.getDay();
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let d = 1; d <= days; d++) {
    const key = ymd(new Date(month.getFullYear(), month.getMonth(), d));
    const meals = sortBySlot(byDay[key] ?? []);
    cells.push({ day: d, key, marks: meals.slice(0, 3).map((x) => kindIcon(x.kind)).join("") + (meals.length > 3 ? "+" : "") });
  }
  return { blanks, cells };
}

export function groupByDay(eaten) {
  const byDay = {};
  for (const e of eaten) (byDay[e.eaten_on] ??= []).push(e);
  return byDay;
}

export const sortBySlot = (meals) => meals.slice().sort((a, b) => (SLOT_ORDER[a.slot] ?? 9) - (SLOT_ORDER[b.slot] ?? 9));

// Macros (grams per serving) live on the regular: carbs_g, protein_g, fat_g, each optional.
export const MACROS = [["carbs_g", "C"], ["protein_g", "P"], ["fat_g", "F"]];
const fmt = (n) => String(Math.round(Number(n) * 10) / 10);

// Calories from macros: 4 kcal/g carbs and protein, 9 kcal/g fat. null when no macro is set.
export function calories(d) {
  if (!d || MACROS.every(([k]) => d[k] == null)) return null;
  return Math.round(4 * Number(d.carbs_g ?? 0) + 4 * Number(d.protein_g ?? 0) + 9 * Number(d.fat_g ?? 0));
}

// "C 40g · P 12g · F 8g · 280 kcal", skipping macros that aren't set; "" when none are.
export function macroText(d) {
  if (!d) return "";
  const parts = MACROS.filter(([k]) => d[k] != null).map(([k, l]) => `${l} ${fmt(d[k])}g`);
  const kcal = calories(d);
  if (kcal != null) parts.push(`${kcal} kcal`);
  return parts.join(" · ");
}

// Each calendar entry carries its own copy of the macros from when it was logged
// (editing a regular later doesn't change it). Totals add those up; null when none are set.
export function sumMacros(entries) {
  const total = { carbs_g: 0, protein_g: 0, fat_g: 0 };
  let any = false;
  for (const e of entries) for (const [k] of MACROS) if (e[k] != null) { total[k] += Number(e[k]); any = true; }
  return any ? total : null;
}

// Share of calories from each macro: "C 50% · P 20% · F 30%"; "" when there are no calories.
export function splitText(t) {
  const kcal = calories(t);
  if (!kcal) return "";
  const kc = { carbs_g: 4 * (t.carbs_g ?? 0), protein_g: 4 * (t.protein_g ?? 0), fat_g: 9 * (t.fat_g ?? 0) };
  return MACROS.map(([k, l]) => `${l} ${Math.round((kc[k] / (kc.carbs_g + kc.protein_g + kc.fat_g)) * 100)}%`).join(" · ");
}

// The Sunday on or before a day (the calendar's weeks start on Sunday).
export function weekStart(dateStr) {
  const d = parseYmd(dateStr);
  return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()));
}
export const addDays = (dateStr, n) => {
  const d = parseYmd(dateStr);
  return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
};

// Seven days from `start`: each day's entries, macro totals and calories, plus the week's
// totals and the average over the days that have macros logged.
export function weekSummary(eaten, start) {
  const byDay = groupByDay(eaten);
  const days = Array.from({ length: 7 }, (_, i) => {
    const key = addDays(start, i);
    const meals = byDay[key] ?? [];
    const totals = sumMacros(meals);
    return { key, meals, totals, kcal: totals ? calories(totals) : null };
  });
  const totals = sumMacros(days.flatMap((d) => d.meals));
  const logged = days.filter((d) => d.totals).length;
  const kcal = totals ? calories(totals) : null;
  return { days, totals, kcal, logged, avg: kcal != null && logged ? Math.round(kcal / logged) : null };
}

// Form text -> number or null; throws on junk or negatives.
export function parseGrams(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) throw new Error("Macros must be numbers, 0 or more.");
  return n;
}
