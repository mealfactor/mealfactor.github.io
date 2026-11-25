import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  STALE_DAYS, esc, kindIcon, cleanName, norm, ymd, parseYmd, firstOfMonth, addMonths,
  daysAgo, agoText, slotForHour, activeDishes, findDish, lastEaten, usualGap, usualSlot, words, groceryMatches, suggestions, regularsList,
  scoreOptions, leader, voteAction, monthCells, groupByDay, sortBySlot, calories, macroText, sumMacros, splitText, weekStart, addDays, weekSummary, parseGrams,
} from "../../lib.js";

const TODAY = "2026-10-21";
const dish = (id, name, kind = "home", extra = {}) => ({ id, name, kind, place: null, archived: false, ...extra });
const ate = (dish_id, eaten_on, extra = {}) => ({ id: `${dish_id}@${eaten_on}`, dish_id, eaten_on, kind: "home", ...extra });

describe("esc", () => {
  test("escapes all HTML-significant characters", () => {
    assert.equal(esc(`<img src=x onerror="alert('1')">&`), "&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;");
  });
  test("null/undefined become empty, numbers become strings", () => {
    assert.equal(esc(null), "");
    assert.equal(esc(undefined), "");
    assert.equal(esc(0), "0");
  });
});

describe("kindIcon", () => {
  test("out vs home, anything else falls back to home", () => {
    assert.equal(kindIcon("out"), "🍽️");
    assert.equal(kindIcon("home"), "🏠");
    assert.equal(kindIcon(undefined), "🏠");
  });
});

describe("cleanName / norm", () => {
  test("trims and collapses inner whitespace including tabs and newlines", () => {
    assert.equal(cleanName("  Kadi \t  Khichadi \n"), "Kadi Khichadi");
  });
  test("norm lowercases on top of cleaning", () => {
    assert.equal(norm("  PANEER   Tikka "), "paneer tikka");
  });
  test("null and undefined are empty strings", () => {
    assert.equal(cleanName(null), "");
    assert.equal(norm(undefined), "");
  });
  test("non-ASCII names are kept", () => {
    assert.equal(norm("  Crème   Brûlée "), "crème brûlée");
  });
});

describe("ymd / parseYmd", () => {
  test("zero-pads month and day", () => {
    assert.equal(ymd(new Date(2026, 0, 5)), "2026-01-05");
  });
  test("round-trips, including a leap day", () => {
    for (const s of ["2026-10-21", "2028-02-29", "2026-12-31", "2027-01-01"]) assert.equal(ymd(parseYmd(s)), s);
  });
  test("parseYmd gives local midnight (not UTC)", () => {
    const d = parseYmd("2026-03-08");
    assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2026, 2, 8, 0]);
  });
});

describe("firstOfMonth / addMonths", () => {
  test("firstOfMonth drops the day", () => {
    assert.equal(ymd(firstOfMonth(new Date(2026, 9, 21))), "2026-10-01");
  });
  test("addMonths crosses year boundaries both ways", () => {
    assert.equal(ymd(addMonths(new Date(2026, 11, 1), 1)), "2027-01-01");
    assert.equal(ymd(addMonths(new Date(2027, 0, 1), -1)), "2026-12-01");
  });
  test("addMonths from the 31st never skips a month", () => {
    assert.equal(ymd(addMonths(new Date(2026, 0, 31), 1)), "2026-02-01");
  });
});

describe("daysAgo", () => {
  test("same day is 0, yesterday is 1", () => {
    assert.equal(daysAgo(TODAY, TODAY), 0);
    assert.equal(daysAgo("2026-10-20", TODAY), 1);
  });
  test("future dates are negative", () => {
    assert.equal(daysAgo("2026-10-24", TODAY), -3);
  });
  test("across month, year and leap-day boundaries", () => {
    assert.equal(daysAgo("2026-09-30", "2026-10-01"), 1);
    assert.equal(daysAgo("2026-12-31", "2027-01-01"), 1);
    assert.equal(daysAgo("2028-02-28", "2028-03-01"), 2);
  });
  test("whole days across DST changes", () => {
    assert.equal(daysAgo("2026-03-07", "2026-03-09"), 2); // US spring forward
    assert.equal(daysAgo("2026-10-31", "2026-11-02"), 2); // US fall back
    assert.equal(daysAgo("2026-03-28", "2026-03-30"), 2); // EU spring forward
  });
});

describe("agoText", () => {
  const cases = [
    [null, "not had yet"], [undefined, "not had yet"],
    ["2026-10-24", "today"], [TODAY, "today"],
    ["2026-10-20", "yesterday"], ["2026-10-19", "2 days ago"], ["2026-10-08", "13 days ago"],
    ["2026-10-07", "2 weeks ago"], ["2026-08-23", "8 weeks ago"],
    ["2026-08-22", "2 months ago"], ["2025-10-22", "12 months ago"],
    ["2025-10-21", "a year ago"], ["2023-10-21", "3 years ago"],
  ];
  for (const [date, want] of cases) {
    test(`${date} -> ${want}`, () => assert.equal(agoText(date, TODAY), want));
  }
});

describe("slotForHour", () => {
  test("boundaries at 11:00 and 16:00", () => {
    assert.deepEqual([0, 10, 11, 15, 16, 23].map(slotForHour), ["breakfast", "breakfast", "lunch", "lunch", "dinner", "dinner"]);
  });
});

describe("findDish", () => {
  const dishes = [dish("a", "Kadi Khichadi"), dish("b", "Pizza", "out", { place: "Slice" }), dish("c", "Pizza"), dish("z", "Old thing", "home", { archived: true })];
  test("matches ignoring case and extra whitespace", () => {
    assert.equal(findDish(dishes, "  kadi   KHICHADI ")?.id, "a");
  });
  test("kind narrows home vs out with the same name", () => {
    assert.equal(findDish(dishes, "pizza", "out")?.id, "b");
    assert.equal(findDish(dishes, "pizza", "home")?.id, "c");
  });
  test("without kind returns the first match", () => {
    assert.ok(["b", "c"].includes(findDish(dishes, "pizza")?.id));
  });
  test("archived regulars are not matched", () => {
    assert.equal(findDish(dishes, "old thing"), undefined);
  });
  test("empty or whitespace-only names never match", () => {
    assert.equal(findDish([dish("e", "")], "   "), undefined);
  });
  test("activeDishes drops archived", () => {
    assert.deepEqual(activeDishes(dishes).map((d) => d.id), ["a", "b", "c"]);
  });
});

describe("lastEaten", () => {
  const eaten = [ate("a", "2026-10-01"), ate("a", "2026-10-15"), ate("b", "2026-10-20"), ate("a", "2026-10-25")];
  test("latest past date for that dish only", () => {
    assert.equal(lastEaten(eaten, "a", TODAY), "2026-10-15");
  });
  test("future-dated entries are ignored", () => {
    assert.equal(lastEaten([ate("a", "2026-11-01")], "a", TODAY), null);
  });
  test("today counts", () => {
    assert.equal(lastEaten([ate("a", TODAY)], "a", TODAY), TODAY);
  });
  test("null when never eaten", () => {
    assert.equal(lastEaten(eaten, "nope", TODAY), null);
    assert.equal(lastEaten([], "a", TODAY), null);
  });
});

const ids = (rows) => rows.map((r) => r.d.id);
const g = (name, extra = {}) => ({ id: name, name, checked: true, created_at: "2026-10-01T10:00:00Z", checked_at: null, ...extra });

describe("usualGap", () => {
  test("fewer than 3 eats falls back to the default", () => {
    assert.equal(usualGap([ate("a", "2026-09-01"), ate("a", "2026-09-08")], "a", TODAY), STALE_DAYS);
  });
  test("median gap of the dish's own history", () => {
    const eaten = ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-29"].map((d) => ate("a", d));
    assert.equal(usualGap(eaten, "a", TODAY), 7);
  });
  test("clamped to 5-90 days; future entries ignored", () => {
    assert.equal(usualGap(["2026-10-01", "2026-10-02", "2026-10-03"].map((d) => ate("a", d)), "a", TODAY), 5);
    assert.equal(usualGap(["2025-01-01", "2026-01-01", "2026-10-01"].map((d) => ate("a", d)), "a", TODAY), 90);
    assert.equal(usualGap([ate("a", "2026-09-01"), ate("a", "2026-09-08"), ate("a", "2026-12-25")], "a", TODAY), STALE_DAYS);
  });
});

describe("usualSlot", () => {
  test("most common logged slot, null without history", () => {
    const eaten = [ate("a", "2026-09-01", { slot: "dinner" }), ate("a", "2026-09-02", { slot: "dinner" }), ate("a", "2026-09-03", { slot: "lunch" })];
    assert.equal(usualSlot(eaten, "a"), "dinner");
    assert.equal(usualSlot(eaten, "b"), null);
    assert.equal(usualSlot([ate("a", "2026-09-01")], "a"), null);
  });
});

describe("groceryMatches", () => {
  test("words drops short words and plurals", () => {
    assert.deepEqual(words("Fresh Tomatoes, 2 packs of eggs"), ["tomato", "egg"]);
  });
  test("ticked groceries match by dish name or ingredients, oldest first", () => {
    const d = dish("a", "Chicken curry", "home", { ingredients: "rice, onions" });
    const gs = [g("onion", { checked_at: "2026-10-19T08:00:00Z" }), g("Chicken thighs", { checked_at: "2026-10-12T08:00:00Z" }), g("milk"), g("rice", { checked: false })];
    assert.deepEqual(groceryMatches(d, gs, TODAY), [{ name: "Chicken thighs", age: 9 }, { name: "onion", age: 2 }]);
  });
});

describe("suggestions", () => {
  test("a weekly dish is overdue sooner than the 14-day default", () => {
    const eaten = ["2026-09-01", "2026-09-08", "2026-09-15", "2026-10-09"].map((d) => ate("w", d));
    const rows = suggestions([dish("w", "Weekly")], eaten, [], TODAY);
    assert.deepEqual(ids(rows), ["w"]);
    assert.equal(rows[0].overdue, 5); // 12 days since, usual gap 7
  });
  test("a monthly dish is not overdue at 20 days", () => {
    const eaten = ["2026-07-01", "2026-08-01", "2026-09-01"].map((d) => ate("m", d));
    assert.deepEqual(suggestions([dish("m", "Monthly")], eaten, [], "2026-09-21"), []);
  });
  test("most overdue first, then never had A-Z", () => {
    const dishes = [dish("n2", "Zucchini"), dish("old", "Old"), dish("n1", "Aloo"), dish("older", "Older")];
    const eaten = [ate("old", "2026-09-01"), ate("older", "2026-06-01")];
    assert.deepEqual(ids(suggestions(dishes, eaten, [], TODAY)), ["older", "old", "n1", "n2"]);
  });
  test("default rule: 14 days is due, 13 is not", () => {
    const dishes = [dish("a", "A"), dish("b", "B")];
    const eaten = [ate("a", "2026-10-07"), ate("b", "2026-10-08")];
    assert.deepEqual(ids(suggestions(dishes, eaten, [], TODAY)), ["a"]);
  });
  test("a dish using bought groceries comes first, even if not overdue", () => {
    const dishes = [dish("old", "Old"), dish("fresh", "Chicken rice")];
    const eaten = [ate("old", "2026-08-01"), ate("fresh", "2026-10-20")];
    const rows = suggestions(dishes, eaten, [g("chicken")], TODAY);
    assert.deepEqual(ids(rows), ["fresh", "old"]);
    assert.equal(rows[0].uses[0].name, "chicken");
  });
  test("the older grocery wins between two dishes that use food", () => {
    const dishes = [dish("a", "Egg fry"), dish("b", "Chicken fry")];
    const gs = [g("egg", { checked_at: "2026-10-19T08:00:00Z" }), g("chicken", { checked_at: "2026-10-10T08:00:00Z" })];
    assert.deepEqual(ids(suggestions(dishes, [], gs, TODAY)), ["b", "a"]);
  });
  test("unticked groceries (still to buy) don't count", () => {
    const rows = suggestions([dish("a", "Chicken rice")], [ate("a", "2026-10-20")], [g("chicken", { checked: false })], TODAY);
    assert.deepEqual(rows, []);
  });
  test("snoozed regulars are hidden until the date passes", () => {
    const d = dish("a", "A", "home", { snoozed_until: "2026-10-28" });
    assert.deepEqual(suggestions([d], [], [], TODAY), []);
    assert.deepEqual(ids(suggestions([d], [], [], "2026-10-28")), ["a"]);
  });
  test("kind filter; archived never suggested", () => {
    const dishes = [dish("h", "H"), dish("o", "O", "out"), dish("x", "X", "home", { archived: true })];
    assert.deepEqual(ids(suggestions(dishes, [], [], TODAY, { kind: "out" })), ["o"]);
    assert.deepEqual(ids(suggestions(dishes, [], [], TODAY)).sort(), ["h", "o"]);
  });
  test("meals usually eaten in another slot sink below the rest", () => {
    const dishes = [dish("brek", "Poha"), dish("din", "Dal")];
    const eaten = [ate("brek", "2026-08-01", { slot: "breakfast" }), ate("din", "2026-09-01", { slot: "dinner" })];
    assert.deepEqual(ids(suggestions(dishes, eaten, [], TODAY, { slot: "dinner" })), ["din", "brek"]);
    assert.deepEqual(ids(suggestions(dishes, eaten, [], TODAY, { slot: "breakfast" })), ["brek", "din"]);
  });
  test("future-only entries count as never had", () => {
    const rows = suggestions([dish("a", "A")], [ate("a", "2026-12-25")], [], TODAY);
    assert.deepEqual(rows.map((r) => [r.d.id, r.last]), [["a", null]]);
  });
});

describe("regularsList", () => {
  test("filters by kind; never-had first, then longest-ago, then A–Z", () => {
    const dishes = [dish("r", "Rajma"), dish("p", "Poha"), dish("a", "Aloo"), dish("o", "Burrito", "out"), dish("x", "Gone", "home", { archived: true })];
    const eaten = [ate("r", "2026-10-20"), ate("p", "2026-09-01")];
    assert.deepEqual(regularsList(dishes, eaten, "home", TODAY).map((r) => r.d.id), ["a", "p", "r"]);
    assert.deepEqual(regularsList(dishes, eaten, "out", TODAY).map((r) => r.d.id), ["o"]);
  });
});

describe("scoreOptions / leader / voteAction", () => {
  const options = [
    { id: "o1", name: "Dal", created_at: "2026-10-21T10:00:00Z" },
    { id: "o2", name: "Pizza", created_at: "2026-10-21T09:00:00Z" },
    { id: "o3", name: "Pasta", created_at: "2026-10-21T08:00:00Z" },
  ];
  const votes = [
    { option_id: "o1", user_id: "me", value: 1 }, { option_id: "o1", user_id: "her", value: 1 },
    { option_id: "o2", user_id: "her", value: 1 }, { option_id: "o2", user_id: "me", value: 1 },
    { option_id: "o3", user_id: "me", value: -1 },
  ];
  test("sums votes and records my vote", () => {
    const s = scoreOptions(options, votes, "me");
    assert.deepEqual(s.map((o) => [o.id, o.score, o.mine]), [["o2", 2, 1], ["o1", 2, 1], ["o3", -1, -1]]);
  });
  test("ties go to the earlier suggestion", () => {
    assert.equal(scoreOptions(options, votes, "me")[0].id, "o2");
  });
  test("options without votes score 0 and mine is 0", () => {
    const s = scoreOptions([{ id: "x", created_at: "1" }], [], "me");
    assert.deepEqual([s[0].score, s[0].mine, s[0].vs], [0, 0, []]);
  });
  test("leader only with a positive score", () => {
    assert.equal(leader([]), null);
    assert.equal(leader(scoreOptions([{ id: "x", created_at: "1" }], [], "me")), null);
    assert.equal(leader(scoreOptions([{ id: "x", created_at: "1" }], [{ option_id: "x", user_id: "me", value: -1 }], "me")), null);
    assert.equal(leader(scoreOptions(options, votes, "me")).id, "o2");
  });
  test("voting the same way again removes the vote; otherwise sets it", () => {
    assert.equal(voteAction(1, 1), "remove");
    assert.equal(voteAction(-1, -1), "remove");
    assert.equal(voteAction(1, -1), "set");
    assert.equal(voteAction(undefined, 1), "set");
    assert.equal(voteAction(0, 1), "set");
  });
});

describe("monthCells / groupByDay / sortBySlot", () => {
  test("October 2026 starts on a Thursday and has 31 days", () => {
    const { blanks, cells } = monthCells(new Date(2026, 9, 1), []);
    assert.equal(blanks, 4);
    assert.equal(cells.length, 31);
    assert.deepEqual([cells[0].key, cells[30].key], ["2026-10-01", "2026-10-31"]);
  });
  test("leap and non-leap Februaries", () => {
    assert.equal(monthCells(new Date(2028, 1, 1), []).cells.length, 29);
    assert.equal(monthCells(new Date(2027, 1, 1), []).cells.length, 28);
  });
  test("a month starting on Sunday has no blanks", () => {
    assert.equal(monthCells(new Date(2026, 1, 1), []).blanks, 0); // Feb 1 2026 is a Sunday
  });
  test("marks show up to 3 meals then +", () => {
    const eaten = [
      ate("a", "2026-10-05"), ate("b", "2026-10-05", { kind: "out" }), ate("c", "2026-10-05"), ate("d", "2026-10-05"),
      ate("e", "2026-10-06", { kind: "out" }),
    ];
    const { cells } = monthCells(new Date(2026, 9, 1), eaten);
    assert.equal(cells[4].marks, "🏠🍽️🏠+");
    assert.equal(cells[5].marks, "🍽️");
    assert.equal(cells[6].marks, "");
  });
  test("marks follow meal order, not the order they were logged", () => {
    const eaten = [ate("a", "2026-10-05", { slot: "dinner" }), ate("b", "2026-10-05", { slot: "breakfast", kind: "out" })];
    assert.equal(monthCells(new Date(2026, 9, 1), eaten).cells[4].marks, "🍽️🏠");
  });
  test("entries outside the month don't leak in", () => {
    const { cells } = monthCells(new Date(2026, 9, 1), [ate("a", "2026-09-30"), ate("b", "2026-11-01")]);
    assert.ok(cells.every((c) => c.marks === ""));
  });
  test("groupByDay buckets by date", () => {
    const g = groupByDay([ate("a", "2026-10-05"), ate("b", "2026-10-05"), ate("c", "2026-10-06")]);
    assert.deepEqual(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.length])), { "2026-10-05": 2, "2026-10-06": 1 });
  });
  test("sortBySlot orders breakfast, lunch, snack, dinner, then unknown; doesn't mutate", () => {
    const meals = [{ slot: "dinner" }, { slot: null }, { slot: "breakfast" }, { slot: "snack" }, { slot: "lunch" }];
    assert.deepEqual(sortBySlot(meals).map((m) => m.slot), ["breakfast", "lunch", "snack", "dinner", null]);
    assert.equal(meals[0].slot, "dinner");
  });
});

describe("macros and calories", () => {
  test("calories = 4/g carbs and protein, 9/g fat; null with no macros", () => {
    assert.equal(calories({ carbs_g: 60, protein_g: 14.5, fat_g: 9 }), 379);
    assert.equal(calories({ carbs_g: 10 }), 40);
    assert.equal(calories({ carbs_g: null, protein_g: null, fat_g: null }), null);
    assert.equal(calories(undefined), null);
  });
  test("macroText lists what is set, then kcal", () => {
    assert.equal(macroText({ carbs_g: 40, protein_g: 12, fat_g: 8 }), "C 40g · P 12g · F 8g · 280 kcal");
    assert.equal(macroText({ protein_g: 20 }), "P 20g · 80 kcal");
    assert.equal(macroText({}), "");
  });
  test("sumMacros adds each entry's own saved macros; null if none have macros", () => {
    const t = sumMacros([{ carbs_g: 10, protein_g: 5, fat_g: 1 }, { carbs_g: 10, protein_g: 5, fat_g: 1 }, { carbs_g: 30 }, {}]);
    assert.deepEqual(t, { carbs_g: 50, protein_g: 10, fat_g: 2 });
    assert.equal(sumMacros([{}, { name: "x" }]), null);
    assert.equal(sumMacros([]), null);
  });
  test("splitText: share of calories from carbs, protein, fat", () => {
    assert.equal(splitText({ carbs_g: 50, protein_g: 25, fat_g: 11.11 }), "C 50% · P 25% · F 25%");
    assert.equal(splitText({ carbs_g: 0, protein_g: 0, fat_g: 0 }), "");
  });
  test("weekStart is the Sunday on or before; addDays crosses months", () => {
    assert.equal(weekStart("2026-10-21"), "2026-10-18"); // Wednesday
    assert.equal(weekStart("2026-10-18"), "2026-10-18");
    assert.equal(weekStart("2026-11-01"), "2026-11-01");
    assert.equal(addDays("2026-10-30", 3), "2026-11-02");
    assert.equal(addDays("2026-10-01", -1), "2026-09-30");
  });
  test("weekSummary: per-day kcal, week totals, average over days with macros", () => {
    const eaten = [
      { id: "1", eaten_on: "2026-10-19", carbs_g: 50, protein_g: 25, fat_g: 10 }, // 390
      { id: "2", eaten_on: "2026-10-19", carbs_g: 10 },                           // 40
      { id: "3", eaten_on: "2026-10-21", protein_g: 50 },                         // 200
      { id: "4", eaten_on: "2026-10-22" },                                        // no macros
      { id: "5", eaten_on: "2026-10-25", fat_g: 100 },                            // outside this week
    ];
    const w = weekSummary(eaten, "2026-10-18");
    assert.deepEqual(w.days.map((d) => d.key), ["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"]);
    assert.deepEqual(w.days.map((d) => d.kcal), [null, 430, null, 200, null, null, null]);
    assert.deepEqual(w.totals, { carbs_g: 60, protein_g: 75, fat_g: 10 });
    assert.equal(w.kcal, 630);
    assert.equal(w.logged, 2);
    assert.equal(w.avg, 315);
    assert.equal(weekSummary([], "2026-10-18").totals, null);
  });
  test("parseGrams: blank is null, numbers parse, junk and negatives throw", () => {
    assert.equal(parseGrams(""), null);
    assert.equal(parseGrams(" 12.5 "), 12.5);
    assert.equal(parseGrams("0"), 0);
    assert.throws(() => parseGrams("abc"));
    assert.throws(() => parseGrams("-3"));
  });
});
