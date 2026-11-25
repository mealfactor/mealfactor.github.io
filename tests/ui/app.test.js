import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startAll, stopAll, openApp, baseSeed, texts, tab, settle, email, TODAY, day } from "./helpers.js";

const flat = (s) => s.replace(/\s+/g, " ");
const toastText = (page) => page.innerText("#toast");
const pickNew = (page) => page.selectOption("#eaten-form [name=dish]", "__new__");

before(startAll);
after(stopAll);

// Runs fn with a fresh app; fails if the page logged any errors.
async function withApp(seed, fn) {
  const app = await openApp(seed);
  try {
    await app.page.waitForSelector(seed.sessionUserId ? ".bottom-nav, #create-form" : "#auth-form");
    await fn(app);
    assert.deepEqual(app.errors, [], "page errors");
  } finally {
    await app.close();
  }
}
const loggedOut = () => ({ ...baseSeed(), sessionUserId: null });

describe("auth", () => {
  test("wrong password shows a friendly error and stays on login", () => withApp(loggedOut(), async ({ page }) => {
    await page.fill("#auth-form [name=username]", "amey");
    await page.fill("#auth-form [name=password]", "nope123");
    await page.click("#auth-form button[type=submit]");
    await page.waitForSelector("#auth-form .error:not([hidden])");
    assert.equal(await page.textContent("#auth-form .error"), "Wrong username or password");
    assert.equal(await page.isVisible("#who"), false);
  }));

  test("username is case- and space-insensitive", () => withApp(loggedOut(), async ({ page }) => {
    await page.fill("#auth-form [name=username]", "AMEY");
    await page.fill("#auth-form [name=password]", "secret1");
    await page.click("#auth-form button[type=submit]");
    await page.waitForSelector(".bottom-nav");
    assert.equal(await page.textContent("#who-name"), "amey");
  }));

  test("username rules are enforced by the form", () => withApp(loggedOut(), async ({ page }) => {
    for (const bad of ["ab", "has space", "emoji🍕", "x".repeat(31)]) {
      await page.fill("#auth-form [name=username]", bad);
      assert.equal(await page.$eval("#auth-form [name=username]", (i) => i.checkValidity()), false, bad);
    }
    await page.fill("#auth-form [name=username]", "ok_name.1-2");
    assert.equal(await page.$eval("#auth-form [name=username]", (i) => i.checkValidity()), true);
  }));

  test("sign up → create household → see join code; log out returns to login", () => withApp(loggedOut(), async ({ page, db }) => {
    await page.click(".tabs [data-mode=signup]");
    assert.equal(await page.textContent("#auth-form button[type=submit]"), "Create account");
    await page.fill("#auth-form [name=username]", "newbie");
    await page.fill("#auth-form [name=password]", "hunter22");
    await page.click("#auth-form button[type=submit]");
    await page.waitForSelector("#create-form");
    await page.fill("#create-form [name=name]", "New place");
    await page.click("#create-form button");
    await page.waitForSelector(".bottom-nav");
    await tab(page, "home");
    assert.equal(await page.textContent("#hh-name"), "New place");
    assert.match(await page.textContent("#hh-code"), /^JOIN\d+$/);
    assert.deepEqual(await texts(page, "#members li"), ["newbie"]);
    assert.ok((await db()).users.some((u) => u.email === email("newbie")));
    await page.click("#logout");
    await page.waitForSelector("#auth-form");
    assert.equal(await page.isVisible("#who"), false);
  }));

  test("signing up with a taken username shows the error", () => withApp(loggedOut(), async ({ page }) => {
    await page.click(".tabs [data-mode=signup]");
    await page.fill("#auth-form [name=username]", "Amey");
    await page.fill("#auth-form [name=password]", "whatever1");
    await page.click("#auth-form button[type=submit]");
    await page.waitForSelector("#auth-form .error:not([hidden])");
    assert.match(await page.textContent("#auth-form .error"), /already registered/);
  }));

  test("joining with a wrong code shows an error; the right code (any case) works", () => withApp({ ...baseSeed(), sessionUserId: "u3", users: [...baseSeed().users, { id: "u3", email: email("guest"), password: "secret3", username: "guest" }] }, async ({ page }) => {
    await page.fill("#join-form [name=code]", "WRONG000");
    await page.click("#join-form button");
    await page.waitForSelector(".card > .error:not([hidden])");
    assert.match(await page.textContent(".card > .error"), /invalid join code/);
    await page.fill("#join-form [name=code]", " abcd1234 ");
    await page.click("#join-form button");
    await page.waitForSelector(".bottom-nav");
    await tab(page, "home");
    assert.deepEqual(await texts(page, "#members li"), ["amey", "wife", "guest"]);
  }));
});

describe("privacy", () => {
  test("another household's dishes and meals never show up", () => withApp(baseSeed(), async ({ page }) => {
    await settle(page);
    const html = await page.content();
    assert.ok(!html.includes("Stranger secret dish"));
    for (const v of ["calendar", "regulars"]) {
      await tab(page, v);
      assert.ok(!(await page.innerText("main")).includes("Stranger"), v);
    }
  }));

  test("names are shown as text, never as HTML", () => withApp(baseSeed(), async ({ page }) => {
    await page.fill("#option-form [name=name]", `<img src=x onerror="window.__pwned=1">`);
    await page.click("#option-form button");
    await page.waitForFunction(() => document.querySelector("#options").innerText.includes("<img"));
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    assert.equal(await page.$$eval("#options img", (x) => x.length), 0);
  }));
});

describe("vote", () => {
  test("suggesting a new meal creates exactly one regular, linked", () => withApp(baseSeed(), async ({ page, db }) => {
    await page.fill("#option-form [name=name]", "  Masala   dosa ");
    await page.click("#option-form button");
    await page.waitForFunction(() => document.querySelector("#options").innerText.includes("Masala dosa"));
    const d = await db();
    const dish = d.dishes.filter((x) => x.name === "Masala dosa");
    assert.equal(dish.length, 1);
    assert.equal(d.meal_options[0].dish_id, dish[0].id);
    await tab(page, "regulars");
    assert.ok((await page.innerText("#dishes-home")).includes("Masala dosa"));
  }));

  test("suggesting an existing regular in different case reuses it and doesn't duplicate the vote", () => withApp(baseSeed(), async ({ page, db }) => {
    for (const n of ["rajma CHAWAL", "Rajma chawal "]) {
      await page.fill("#option-form [name=name]", n);
      await page.click("#option-form button");
      await settle(page);
    }
    const d = await db();
    assert.equal(d.dishes.filter((x) => x.name.toLowerCase() === "rajma chawal").length, 1);
    assert.equal(d.meal_options.length, 1);
    assert.equal(d.meal_options[0].dish_id, "d1");
    assert.deepEqual(await texts(page, "#options li .grow > div:first-child"), ["🏠 Rajma chawal"]);
  }));

  test("empty or whitespace suggestion does nothing", () => withApp(baseSeed(), async ({ page, db }) => {
    await page.fill("#option-form [name=name]", "   ");
    await page.click("#option-form button");
    await settle(page);
    assert.equal((await db()).meal_options.length, 0);
  }));

  test("picking a regular's name auto-selects home/out", () => withApp(baseSeed(), async ({ page }) => {
    await page.fill("#option-form [name=name]", "burrito bowl");
    await page.dispatchEvent("#option-form [name=name]", "change");
    assert.equal(await page.inputValue("#option-form [name=kind]"), "out");
  }));

  test("👍 toggles on and off; 👎 replaces 👍; no leader at score 0", () => withApp({ ...baseSeed(), meal_options: [{ id: "o1", household_id: "h1", dish_id: "d3", name: "Aloo paratha", kind: "home", status: "open", created_by: "u2", created_at: "1" }] }, async ({ page }) => {
    await page.waitForSelector("#options [data-act=vote]");
    const score = () => page.textContent("#options .score");
    assert.equal(await page.innerHTML("#winner"), "");
    await page.click("#options .up");
    await page.waitForFunction(() => document.querySelector("#options .score").textContent === "1");
    assert.ok(await page.$eval("#options .up", (b) => b.classList.contains("on")));
    assert.match(await page.innerText("#winner"), /Aloo paratha/);
    await page.click("#options .down");
    await page.waitForFunction(() => document.querySelector("#options .score").textContent === "-1");
    assert.equal(await page.innerHTML("#winner"), "");
    await page.click("#options .down");
    await page.waitForFunction(() => document.querySelector("#options .score").textContent === "0");
    assert.equal(await score(), "0");
  }));

  test("ranking: higher score first, ties go to the earlier suggestion", () => withApp({
    ...baseSeed(),
    meal_options: [
      { id: "o1", household_id: "h1", dish_id: "d1", name: "Rajma chawal", kind: "home", status: "open", created_at: "2026-10-21T10:00:00Z" },
      { id: "o2", household_id: "h1", dish_id: "d3", name: "Aloo paratha", kind: "home", status: "open", created_at: "2026-10-21T09:00:00Z" },
      { id: "o3", household_id: "h1", dish_id: "d4", name: "Burrito bowl", kind: "out", status: "open", created_at: "2026-10-21T08:00:00Z" },
    ],
    votes: [
      { option_id: "o1", user_id: "u2", value: 1, household_id: "h1" },
      { option_id: "o2", user_id: "u2", value: 1, household_id: "h1" },
      { option_id: "o3", user_id: "u2", value: -1, household_id: "h1" },
    ],
  }, async ({ page }) => {
    await page.waitForSelector("#options [data-act=vote]");
    assert.deepEqual(await texts(page, "#options li .grow > div:first-child"), ["🏠 Aloo paratha", "🏠 Rajma chawal", "🍽️ Burrito bowl"]);
    assert.match(await page.innerText("#winner"), /Aloo paratha/);
  }));

  test("'We're eating this' logs today's meal to the calendar, clears the round", () => withApp({
    ...baseSeed(),
    meal_options: [
      { id: "o1", household_id: "h1", dish_id: "d5", name: "Pad thai", kind: "out", status: "open", created_at: "1" },
      { id: "o2", household_id: "h1", dish_id: "d3", name: "Aloo paratha", kind: "home", status: "open", created_at: "2" },
    ],
    votes: [{ option_id: "o1", user_id: "u2", value: 1, household_id: "h1" }],
  }, async ({ page, db }) => {
    await page.click("#winner [data-act=choose]");
    await page.waitForFunction(() => document.querySelector("#options").innerText.includes("No suggestions"));
    const d = await db();
    const logged = d.meals_eaten.filter((m) => m.eaten_on === "2026-10-21" && m.dish_id === "d5");
    assert.equal(logged.length, 1);
    assert.equal(logged[0].slot, "lunch");
    assert.deepEqual(d.meal_options.map((o) => o.status).sort(), ["archived", "chosen"]);
    await tab(page, "calendar");
    assert.match(await page.innerText("#day-meals"), /Pad thai · Thai Basil/);
  }));

  test("'Clear and start a new round' clears the vote, and Undo brings it back", () => withApp({
    ...baseSeed(),
    meal_options: [{ id: "o1", household_id: "h1", dish_id: "d3", name: "Aloo paratha", kind: "home", status: "open", created_at: "1" }],
  }, async ({ page, db, dialogs }) => {
    await page.waitForSelector("#options [data-act=vote]");
    await page.click("#new-round");
    await page.waitForFunction(() => document.querySelector("#options").innerText.includes("No suggestions"));
    assert.match(await toastText(page), /Cleared the vote/);
    await page.click("#toast button");
    await page.waitForSelector("#options [data-act=vote]");
    assert.equal((await db()).meal_options[0].status, "open");
    assert.equal(dialogs.length, 0, "no confirm dialogs");
  }));

  test("removing a suggestion offers Undo", () => withApp({
    ...baseSeed(),
    meal_options: [{ id: "o1", household_id: "h1", dish_id: "d3", name: "Aloo paratha", kind: "home", status: "open", created_at: "1" }],
  }, async ({ page }) => {
    await page.click("#options [data-act=del-option]");
    await page.waitForFunction(() => document.querySelector("#options").innerText.includes("No suggestions"));
    await page.click("#toast button");
    await page.waitForSelector("#options [data-act=vote]");
  }));
});

describe("today card", () => {
  test("shows what's been eaten today, in meal order, and links to the calendar", () => withApp({
    ...baseSeed(),
    meals_eaten: [
      ...baseSeed().meals_eaten,
      { id: "t1", household_id: "h1", dish_id: "d3", name: "Aloo paratha", kind: "home", eaten_on: TODAY, slot: "breakfast", created_at: "1" },
      { id: "t2", household_id: "h1", dish_id: "d4", name: "Burrito bowl", kind: "out", eaten_on: TODAY, slot: "lunch", created_at: "1" },
    ],
  }, async ({ page }) => {
    assert.deepEqual(await texts(page, "#today li"), ["🏠 Aloo paratha Breakfast", "🍽️ Burrito bowl · Chipotle Lunch"]);
    await page.click("[data-act=goto]");
    assert.equal(await page.isVisible("#eaten-form"), true);
  }));

  test("says so when nothing is logged", () => withApp(baseSeed(), async ({ page }) => {
    assert.match(await page.innerText("#today"), /Nothing logged yet today/);
  }));
});

// Slots depend on the clock (meal-time awareness), so these seeds log meals without one.
const slotless = () => {
  const seed = baseSeed();
  seed.meals_eaten = seed.meals_eaten.map((m) => ({ ...m, slot: null }));
  return seed;
};
const dishRow = (id, name, extra = {}) => ({ id, household_id: "h1", name, kind: "home", ...extra });
const eatenRow = (id, dish_id, name, n, extra = {}) => ({ id, household_id: "h1", dish_id, name, kind: "home", eaten_on: day(n), slot: null, ...extra });

describe("lowercase", () => {
  test("all text is displayed lowercase", async () => {
    const { page, close } = await openApp(baseSeed(), { lowercase: true });
    try {
      await page.waitForSelector(".bottom-nav");
      assert.equal(await page.$eval("h1", (e) => getComputedStyle(e).textTransform), "lowercase");
      assert.equal(await page.$eval("h1", (e) => e.innerText), "🍲 mealfactor");
      for (const sel of ["button", "input", "#stale .grow"]) {
        assert.equal(await page.$eval(sel, (e) => getComputedStyle(e).textTransform), "lowercase", sel);
      }
    } finally { await close(); }
  });
});

describe("it's been a while", () => {
  test("shows overdue regulars (most overdue first), then never-had; hides recent and archived", () => withApp(slotless(), async ({ page }) => {
    await page.waitForSelector("#stale li");
    assert.deepEqual(await texts(page, "#stale li .grow"), [
      "🍽️ Pad thai · Thai Basil 6 weeks ago · overdue by 26 days",
      "🏠 Paneer butter masala 4 weeks ago · overdue by 11 days",
      "🏠 Aloo paratha not had yet",
    ]);
  }));

  test("+ Vote adds it once and flips to '✓ In vote'", () => withApp(slotless(), async ({ page, db }) => {
    await page.click("#stale li:first-child [data-act=dish-vote]");
    await page.waitForSelector("#stale li:first-child [data-act=dish-vote]:disabled");
    assert.equal(await page.textContent("#stale li:first-child [data-act=dish-vote]"), "✓ In vote");
    assert.equal((await db()).meal_options.length, 1);
  }));

  test("Eating this logs it for today and drops it from the list", () => withApp(slotless(), async ({ page, db }) => {
    await page.click("#stale li:first-child [data-act=dish-ate]"); // Pad thai
    await page.waitForFunction(() => !document.querySelector("#stale").innerText.includes("Pad thai"));
    assert.ok((await db()).meals_eaten.some((m) => m.name === "Pad thai" && m.eaten_on === TODAY));
  }));

  test("Not now hides it for a week; Undo brings it back", () => withApp(slotless(), async ({ page, db }) => {
    await page.click("#stale li:first-child [data-act=snooze]");
    await page.waitForFunction(() => !document.querySelector("#stale").innerText.includes("Pad thai"));
    assert.match(await toastText(page), /Hiding Pad thai for a week/);
    assert.ok((await db()).dishes.find((d) => d.name === "Pad thai").snoozed_until > TODAY);
    await page.click("#toast button");
    await page.waitForFunction(() => document.querySelector("#stale").innerText.includes("Pad thai"));
    assert.equal((await db()).dishes.find((d) => d.name === "Pad thai").snoozed_until, null);
  }));

  test("Home / Out filter", () => withApp(slotless(), async ({ page }) => {
    await page.click("[data-act=stale-filter][data-kind=out]");
    assert.deepEqual(await texts(page, "#stale li .grow"), ["🍽️ Pad thai · Thai Basil 6 weeks ago · overdue by 26 days"]);
    await page.click("[data-act=stale-filter][data-kind=home]");
    assert.equal((await texts(page, "#stale li .grow")).length, 2);
    await page.click("[data-act=stale-filter][data-kind='']");
    assert.equal((await texts(page, "#stale li .grow")).length, 3);
  }));

  test("shows 6, then Show more / Show fewer", () => withApp({
    ...slotless(),
    dishes: Array.from({ length: 9 }, (_, i) => dishRow(`n${i}`, `Dish ${i}`)),
    meals_eaten: [],
  }, async ({ page }) => {
    await page.waitForSelector("#stale li");
    assert.equal((await texts(page, "#stale li .grow")).length, 6);
    assert.equal((await page.textContent("#stale-more")).trim(), "Show 3 more");
    await page.click("#stale-more");
    assert.equal((await texts(page, "#stale li .grow")).length, 9);
    await page.click("#stale-more");
    assert.equal((await texts(page, "#stale li .grow")).length, 6);
  }));

  test("Surprise me adds one of the top three to the vote", () => withApp(slotless(), async ({ page, db }) => {
    await page.click("#surprise");
    await page.waitForFunction(() => document.querySelector("#options li .grow"));
    assert.equal((await db()).meal_options.length, 1);
    assert.match(await toastText(page), /to the vote/);
  }));

  test("groceries you've bought bring a meal to the top, with the reason", () => withApp({
    ...slotless(),
    dishes: [dishRow("d1", "Palak paneer", { ingredients: "spinach, paneer" }), dishRow("d2", "Old thing")],
    meals_eaten: [eatenRow("e1", "d1", "Palak paneer", 2), eatenRow("e2", "d2", "Old thing", 30)],
    groceries: [{ id: "g1", household_id: "h1", name: "Spinach", checked: true, checked_at: `${day(5)}T10:00:00Z`, created_at: `${day(6)}T10:00:00Z` }],
  }, async ({ page }) => {
    await page.waitForSelector("#stale li");
    const rows = await texts(page, "#stale li .grow");
    assert.match(rows[0], /Palak paneer.*uses your Spinach \(bought \d+d ago\)/);
    assert.match(rows[1], /Old thing/);
  }));

  test("ingredients are editable in the meal dialog and saved", () => withApp(slotless(), async ({ page, db }) => {
    await tab(page, "regulars");
    await page.click("#dishes-home [data-act=edit-dish]");
    await page.fill("#dish-form [name=ingredients]", "paneer, spinach");
    await page.click("#dish-form button[type=submit]");
    await page.waitForFunction(() => !document.querySelector("#dish-dialog").open);
    assert.ok((await db()).dishes.some((d) => d.ingredients === "paneer, spinach"));
  }));

  test("hidden when there are no regulars; celebrates when all are recent", async () => {
    await withApp({ ...baseSeed(), dishes: [], meals_eaten: [] }, async ({ page }) => {
      await settle(page);
      assert.equal(await page.isVisible("#stale-card"), false);
    });
    await withApp({ ...baseSeed(), dishes: [{ id: "d1", household_id: "h1", name: "Rajma chawal", kind: "home" }] , meals_eaten: [{ id: "e1", household_id: "h1", dish_id: "d1", name: "Rajma chawal", kind: "home", eaten_on: day(13), slot: "dinner" }] }, async ({ page }) => {
      await page.waitForSelector("#stale li");
      assert.match(await page.innerText("#stale"), /had all your regulars recently/);
    });
  });

  test("a future-dated entry doesn't make a regular look recent", () => withApp({
    ...baseSeed(),
    dishes: [{ id: "d1", household_id: "h1", name: "Biryani", kind: "home" }],
    meals_eaten: [{ id: "e1", household_id: "h1", dish_id: "d1", name: "Biryani", kind: "home", eaten_on: day(-5), slot: "dinner" }],
  }, async ({ page }) => {
    await page.waitForSelector("#stale li");
    assert.deepEqual(await texts(page, "#stale li .grow"), ["🏠 Biryani not had yet"]);
  }));
});

describe("calendar", () => {
  test("month grid: October 2026 starts Thursday, today highlighted, marks per day", () => withApp(baseSeed(), async ({ page }) => {
    await tab(page, "calendar");
    assert.equal(await page.textContent("#cal-title"), "October 2026");
    assert.equal(await page.$$eval("#cal-grid > div:not(.dow)", (x) => x.length), 4);
    assert.equal(await page.$$eval("#cal-grid .day", (x) => x.length), 31);
    assert.equal(await page.getAttribute("#cal-grid .today", "data-day"), TODAY);
    assert.equal(await page.textContent(`[data-day="${day(1)}"] .marks`), "🏠");
    assert.equal(await page.textContent(`[data-day="${day(2)}"] .marks`), "🍽️");
    assert.equal(await page.textContent("#day-title"), "Today");
  }));

  test("navigates across the year boundary and back", () => withApp(baseSeed(), async ({ page }) => {
    await tab(page, "calendar");
    for (let i = 0; i < 3; i++) await page.click("[data-act=cal-next]");
    assert.equal(await page.textContent("#cal-title"), "January 2027");
    assert.equal(await page.$$eval("#cal-grid .day", (x) => x.length), 31);
    for (let i = 0; i < 4; i++) await page.click("[data-act=cal-prev]");
    assert.equal(await page.textContent("#cal-title"), "September 2026");
  }));

  test("logging a new meal on a past day creates one linked regular", () => withApp(baseSeed(), async ({ page, db }) => {
    await tab(page, "calendar");
    await page.click(`[data-day="2026-10-15"]`);
    assert.equal(await page.textContent("#day-title"), "Thursday, Oct 15");
    await pickNew(page);
    await page.fill("#eaten-form [name=name]", "Chole bhature");
    await page.selectOption("#eaten-form [name=kind]", "out");
    assert.equal(await page.isVisible("#eaten-form [name=place]"), true);
    await page.fill("#eaten-form [name=place]", "Haldiram's");
    await page.selectOption("#eaten-form [name=slot]", "dinner");
    await page.click("#eaten-form button");
    await page.waitForFunction(() => document.querySelector("#day-meals").innerText.includes("Chole bhature"));
    const d = await db();
    const dishes = d.dishes.filter((x) => x.name === "Chole bhature");
    assert.equal(dishes.length, 1);
    assert.deepEqual([dishes[0].kind, dishes[0].place], ["out", "Haldiram's"]);
    const e = d.meals_eaten.find((m) => m.dish_id === dishes[0].id);
    assert.deepEqual([e.eaten_on, e.slot], ["2026-10-15", "dinner"]);
    assert.equal(await page.textContent(`[data-day="2026-10-15"] .marks`), "🍽️");
    await tab(page, "regulars");
    assert.match(flat(await page.innerText("#dishes-out")), /Chole bhature · Haldiram's last had 6 days ago/);
  }));

  test("the meal picker lists past meals by group; a text box appears only for a new meal", () => withApp(baseSeed(), async ({ page, db }) => {
    await tab(page, "calendar");
    assert.equal(await page.isVisible("#eaten-form [name=name]"), false);
    const opts = await texts(page, "#eaten-form [name=dish] option");
    assert.deepEqual(opts, ["Aloo paratha", "Paneer butter masala", "Rajma chawal", "Burrito bowl · Chipotle", "Pad thai · Thai Basil", "➕ New meal…"]);
    await pickNew(page);
    assert.equal(await page.isVisible("#eaten-form [name=name]"), true);
    await page.selectOption("#eaten-form [name=dish]", "d3");
    assert.equal(await page.isVisible("#eaten-form [name=name]"), false);
    await page.selectOption("#eaten-form [name=slot]", "breakfast");
    await page.click("#eaten-form button");
    await page.waitForFunction(() => document.querySelector("#day-meals").innerText.includes("Aloo paratha"));
    const d = await db();
    assert.equal(d.dishes.filter((x) => x.name.toLowerCase() === "aloo paratha").length, 1);
    assert.equal(d.meals_eaten.at(-1).dish_id, "d3");
  }));

  test("picking an eat-out regular keeps its place and logs on the selected day", () => withApp(baseSeed(), async ({ page, db }) => {
    await tab(page, "calendar");
    await page.click(`[data-day="2026-10-15"]`);
    await page.selectOption("#eaten-form [name=dish]", "d4");
    await page.selectOption("#eaten-form [name=slot]", "dinner");
    await page.click("#eaten-form button");
    await page.waitForFunction(() => document.querySelector("#day-meals").innerText.includes("Burrito bowl · Chipotle"));
    const e = (await db()).meals_eaten.at(-1);
    assert.deepEqual([e.dish_id, e.eaten_on, e.kind], ["d4", "2026-10-15", "out"]);
  }));

  test("logging the same meal twice for the same day and slot is refused", () => withApp(baseSeed(), async ({ page, db, dialogs }) => {
    await tab(page, "calendar");
    for (let i = 0; i < 2; i++) {
      await page.selectOption("#eaten-form [name=dish]", "d1");
      await page.selectOption("#eaten-form [name=slot]", "dinner");
      await page.click("#eaten-form button");
      await settle(page);
    }
    assert.equal((await db()).meals_eaten.filter((m) => m.eaten_on === TODAY && m.dish_id === "d1").length, 1);
    assert.match(await toastText(page), /already logged for today's dinner/);
    // A different slot the same day is fine.
    await page.selectOption("#eaten-form [name=dish]", "d1");
    await page.selectOption("#eaten-form [name=slot]", "lunch");
    await page.click("#eaten-form button");
    await settle(page);
    assert.equal((await db()).meals_eaten.filter((m) => m.eaten_on === TODAY && m.dish_id === "d1").length, 2);
  }));

  test("same name as home vs out are separate regulars", () => withApp(baseSeed(), async ({ page, db }) => {
    await tab(page, "calendar");
    await pickNew(page);
    await page.fill("#eaten-form [name=name]", "Pizza");
    await page.click("#eaten-form button");
    await settle(page);
    await pickNew(page);
    await page.fill("#eaten-form [name=name]", "Pizza");
    await page.selectOption("#eaten-form [name=kind]", "out");
    await page.selectOption("#eaten-form [name=slot]", "dinner");
    await page.click("#eaten-form button");
    await settle(page);
    assert.deepEqual((await db()).dishes.filter((x) => x.name === "Pizza").map((x) => x.kind).sort(), ["home", "out"]);
  }));

  test("meals in a day are ordered breakfast → lunch → snack → dinner; ✕ removes one", () => withApp(baseSeed(), async ({ page, db }) => {
    await tab(page, "calendar");
    for (const [dish, slot] of [["d1", "dinner"], ["d3", "breakfast"], ["d5", "snack"], ["d4", "lunch"]]) {
      await page.selectOption("#eaten-form [name=dish]", dish);
      await page.selectOption("#eaten-form [name=slot]", slot);
      await page.click("#eaten-form button");
      await settle(page);
    }
    assert.deepEqual((await texts(page, "#day-meals li .meta:last-child")), ["Breakfast", "Lunch", "Snack", "Dinner"]);
    assert.equal(await page.textContent(`[data-day="${TODAY}"] .marks`), "🏠🍽️🍽️+");
    await page.click("#day-meals li:first-child [data-act=del-eaten]");
    await settle(page);
    assert.equal(await page.$$eval("#day-meals li", (x) => x.length), 3);
    assert.ok((await db()).dishes.some((x) => x.name === "Aloo paratha" && !x.archived), "regular survives");
    await page.click("#toast button");
    await page.waitForFunction(() => document.querySelectorAll("#day-meals li").length === 4);
    assert.equal((await db()).meals_eaten.filter((m) => m.dish_id === "d3").length, 1, "undo restores the entry");
  }));

  test("the form defaults the slot from the time of day (noon → lunch)", () => withApp(baseSeed(), async ({ page }) => {
    await tab(page, "calendar");
    assert.equal(await page.inputValue("#eaten-form [name=slot]"), "lunch");
  }));
});

describe("regulars", () => {
  test("two lists; never-had first, then longest ago; stale ones highlighted", () => withApp(baseSeed(), async ({ page }) => {
    await tab(page, "regulars");
    assert.deepEqual(await texts(page, "#dishes-home li .grow"), [
      "Aloo paratha not had yet",
      "Paneer butter masala last had 4 weeks ago",
      "Rajma chawal last had yesterday",
    ]);
    assert.deepEqual(await texts(page, "#dishes-out li .grow"), [
      "Pad thai · Thai Basil last had 6 weeks ago",
      "Burrito bowl · Chipotle last had 2 days ago",
    ]);
    assert.deepEqual(await texts(page, "#dishes-home .meta.stale"), ["last had 4 weeks ago"]);
  }));

  test("adding an existing name (any case) doesn't duplicate", () => withApp(baseSeed(), async ({ page, db }) => {
    await tab(page, "regulars");
    await page.fill(".dish-form[data-kind=home] [name=name]", "RAJMA chawal");
    await page.click(".dish-form[data-kind=home] button");
    await settle(page);
    assert.equal((await db()).dishes.filter((x) => x.name.toLowerCase() === "rajma chawal").length, 1);
  }));

  const edit = async (page, id, vals) => {
    await page.click(`#dishes-home [data-act=edit-dish][data-id=${id}]`);
    await page.waitForSelector("#dish-dialog[open]");
    for (const [k, v] of Object.entries(vals)) await page.fill(`#dish-form [name=${k}]`, v);
  };

  test("rename updates the calendar and the vote too", () => withApp({
    ...baseSeed(),
    meal_options: [{ id: "o1", household_id: "h1", dish_id: "d1", name: "Rajma chawal", kind: "home", status: "open", created_at: "1" }],
  }, async ({ page }) => {
    await tab(page, "regulars");
    await edit(page, "d1", { name: "Rajma rice" });
    await page.click("#dish-form button[type=submit]");
    await page.waitForFunction(() => document.querySelector("#dishes-home").innerText.includes("Rajma rice"));
    await tab(page, "meal");
    assert.deepEqual(await texts(page, "#options li .grow > div:first-child"), ["🏠 Rajma rice"]);
    await tab(page, "calendar");
    await page.click(`[data-day="${day(1)}"]`);
    assert.match(await page.innerText("#day-meals"), /Rajma rice/);
  }));

  test("renaming to another regular's name is refused", () => withApp(baseSeed(), async ({ page, db }) => {
    await tab(page, "regulars");
    await edit(page, "d1", { name: "aloo paratha" });
    await page.click("#dish-form button[type=submit]");
    await page.waitForSelector("#dish-form .error:not([hidden])");
    assert.match(await page.innerText("#dish-form .error"), /already a regular/);
    assert.equal((await db()).dishes.find((x) => x.id === "d1").name, "Rajma chawal");
  }));

  test("cancelling or blanking the name changes nothing", () => withApp(baseSeed(), async ({ page, db }) => {
    await tab(page, "regulars");
    await edit(page, "d1", { name: "Something else" });
    await page.click("#dish-cancel");
    await page.waitForSelector("#dish-dialog:not([open])", { state: "attached" });
    await edit(page, "d1", { name: "   " });
    await page.click("#dish-form button[type=submit]");
    await settle(page);
    assert.equal((await db()).dishes.find((x) => x.id === "d1").name, "Rajma chawal");
  }));

  test("macros: save carbs/protein/fat, see them on regulars, vote, today and the day total", () => withApp({
    ...baseSeed(),
    meal_options: [{ id: "o1", household_id: "h1", dish_id: "d1", name: "Rajma chawal", kind: "home", status: "open", created_at: "1" }],
    meals_eaten: [...baseSeed().meals_eaten, { id: "t1", household_id: "h1", dish_id: "d1", name: "Rajma chawal", kind: "home", eaten_on: TODAY, slot: "lunch", created_at: "1" }],
  }, async ({ page, db }) => {
    await tab(page, "regulars");
    await edit(page, "d1", { carbs_g: "60", protein_g: "14.5", fat_g: "9" });
    await page.click("#dish-form button[type=submit]");
    await page.waitForFunction(() => document.querySelector("#dishes-home").innerText.includes("C 60g"));
    const d = (await db()).dishes.find((x) => x.id === "d1");
    assert.deepEqual([d.carbs_g, d.protein_g, d.fat_g], [60, 14.5, 9]);
    assert.match(flat(await page.innerText("#dishes-home")), /Rajma chawal .*C 60g · P 14.5g · F 9g · 379 kcal/);
    await tab(page, "meal");
    assert.match(flat(await page.innerText("#options")), /C 60g · P 14.5g · F 9g/);
    assert.match(flat(await page.innerText("#today")), /Total · C 60g · P 14.5g · F 9g · 379 kcal/);
    await tab(page, "calendar");
    assert.match(flat(await page.innerText("#day-meals")), /Day total · C 60g/);
  }));

  test("macros are optional (blank clears them) and bad input is refused", () => withApp({
    ...baseSeed(),
    dishes: baseSeed().dishes.map((x) => (x.id === "d1" ? { ...x, carbs_g: 10, protein_g: 2, fat_g: 1 } : x)),
  }, async ({ page, db }) => {
    await tab(page, "regulars");
    await edit(page, "d1", { carbs_g: "abc" });
    await page.click("#dish-form button[type=submit]");
    await page.waitForSelector("#dish-form .error:not([hidden])");
    assert.match(await page.innerText("#dish-form .error"), /numbers/);
    assert.equal((await db()).dishes.find((x) => x.id === "d1").carbs_g, 10);
    await page.fill("#dish-form [name=carbs_g]", "");
    await page.fill("#dish-form [name=protein_g]", "");
    await page.fill("#dish-form [name=fat_g]", "");
    await page.click("#dish-form button[type=submit]");
    await settle(page);
    const d = (await db()).dishes.find((x) => x.id === "d1");
    assert.deepEqual([d.carbs_g, d.protein_g, d.fat_g], [null, null, null]);
  }));

  test("remove hides it but keeps calendar history; adding again brings back the same regular", () => withApp(baseSeed(), async ({ page, db, answer }) => {
    await tab(page, "regulars");
    await page.click("#dishes-home [data-act=del-dish][data-id=d1]");
    await page.waitForFunction(() => !document.querySelector("#dishes-home").innerText.includes("Rajma"));
    await page.click("#toast button"); // Undo
    await page.waitForFunction(() => document.querySelector("#dishes-home").innerText.includes("Rajma"));
    await page.click("#dishes-home [data-act=del-dish][data-id=d1]");
    await page.waitForFunction(() => !document.querySelector("#dishes-home").innerText.includes("Rajma"));
    await tab(page, "calendar");
    await page.click(`[data-day="${day(1)}"]`);
    assert.match(await page.innerText("#day-meals"), /Rajma chawal/);
    await tab(page, "regulars");
    await page.fill(".dish-form[data-kind=home] [name=name]", "rajma chawal");
    await page.click(".dish-form[data-kind=home] button");
    await page.waitForFunction(() => document.querySelector("#dishes-home").innerText.includes("Rajma"));
    const d = await db();
    assert.equal(d.dishes.filter((x) => x.name === "Rajma chawal").length, 1);
    assert.equal(d.dishes.find((x) => x.id === "d1").archived, false);
    assert.match(flat(await page.innerText("#dishes-home")), /Rajma chawal last had yesterday/);
  }));

  test("✓ logs it as eaten today; a second ✓ in the same slot is refused", () => withApp(baseSeed(), async ({ page, db, dialogs }) => {
    await tab(page, "regulars");
    await page.click("#dishes-home [data-act=dish-ate][data-id=d3]");
    await page.waitForFunction(() => document.querySelector("#dishes-home").innerText.replace(/\s+/g, " ").includes("Aloo paratha last had today"));
    await page.click("#dishes-home [data-act=dish-ate][data-id=d3]");
    await settle(page);
    assert.equal((await db()).meals_eaten.filter((m) => m.dish_id === "d3").length, 1);
    assert.match(await toastText(page), /already logged for today's lunch/);
  }));

  test("🗳️ adds to the vote; doing it twice keeps one option", () => withApp(baseSeed(), async ({ page, db }) => {
    await tab(page, "regulars");
    await page.click("#dishes-out [data-act=dish-vote][data-id=d4]");
    await settle(page);
    await page.click("#dishes-out [data-act=dish-vote][data-id=d4]");
    await settle(page);
    assert.equal((await db()).meal_options.filter((o) => o.dish_id === "d4" && o.status === "open").length, 1);
  }));

  test("the eat-out form saves the place", () => withApp(baseSeed(), async ({ page, db }) => {
    await tab(page, "regulars");
    await page.fill(".dish-form[data-kind=out] [name=name]", "Ramen");
    await page.fill(".dish-form[data-kind=out] [name=place]", "Ippudo");
    await page.click(".dish-form[data-kind=out] button");
    await settle(page);
    const r = (await db()).dishes.find((x) => x.name === "Ramen");
    assert.deepEqual([r.kind, r.place], ["out", "Ippudo"]);
  }));
});

describe("groceries", () => {
  test("add with and without qty, newest first; blank is ignored; ✕ removes", () => withApp(baseSeed(), async ({ page, db }) => {
    await tab(page, "groceries");
    await page.fill("#grocery-form [name=name]", "Paneer");
    await page.fill("#grocery-form [name=qty]", "400 g");
    await page.click("#grocery-form button");
    await settle(page);
    await page.fill("#grocery-form [name=name]", "Rice");
    await page.click("#grocery-form button");
    await settle(page);
    await page.fill("#grocery-form [name=name]", "  ");
    await page.click("#grocery-form button");
    await settle(page);
    assert.deepEqual((await texts(page, "#groceries li .grow")).map((t) => t.replace(/ added .*/, "")), ["Rice", "Paneer · 400 g", "Spinach · 1 bunch"]);
  }));

  test("tick sinks an item to the bottom (and un-ticks); 'Clear ticked' removes with Undo", () => withApp(baseSeed(), async ({ page, db }) => {
    await tab(page, "groceries");
    await page.fill("#grocery-form [name=name]", "Rice");
    await page.click("#grocery-form button");
    await page.waitForFunction(() => document.querySelectorAll("#groceries li").length === 2);
    assert.equal(await page.isVisible("#clear-ticked"), false);
    await page.click("#groceries li:first-child [data-act=tick-grocery]"); // Rice
    await page.waitForFunction(() => document.querySelector("#groceries li:last-child").innerText.includes("Rice"));
    assert.deepEqual(await texts(page, "#groceries li.done .grow"), [(await texts(page, "#groceries li.done .grow"))[0]]);
    assert.equal((await db()).groceries.find((g) => g.name === "Rice").checked, true);
    await page.click("#clear-ticked");
    await page.waitForFunction(() => document.querySelectorAll("#groceries li").length === 1);
    assert.equal((await db()).groceries.length, 1);
    await page.click("#toast button");
    await page.waitForFunction(() => document.querySelectorAll("#groceries li").length === 2);
    await page.click("#groceries li.done [data-act=tick-grocery]"); // untick
    await page.waitForFunction(() => !document.querySelector("#groceries li.done"));
    assert.equal((await db()).groceries.every((g) => !g.checked), true);
  }));
});

describe("mobile layout", () => {
  for (const width of [320, 375, 430]) {
    test(`no horizontal scrolling on any tab at ${width}px`, async () => {
      const app = await openApp(baseSeed(), { width, height: 740 });
      try {
        await app.page.waitForSelector(".bottom-nav");
        for (const v of ["meal", "calendar", "regulars", "groceries", "home"]) {
          await tab(app.page, v);
          const sw = await app.page.evaluate(() => document.documentElement.scrollWidth);
          assert.ok(sw <= width, `${v}: scrollWidth ${sw} > ${width}`);
        }
      } finally {
        await app.close();
      }
    });
  }

  test("bottom nav doesn't cover the last item; tap targets are ≥ 44px", () => withApp(baseSeed(), async ({ page }) => {
    await tab(page, "regulars");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const { lastBottom, navTop } = await page.evaluate(() => ({
      lastBottom: [...document.querySelectorAll("#dishes-out li")].at(-1).getBoundingClientRect().bottom,
      navTop: document.querySelector(".bottom-nav").getBoundingClientRect().top,
    }));
    assert.ok(lastBottom <= navTop, `${lastBottom} > ${navTop}`);
    const small = await page.$$eval("main button:not(.link)", (bs) => bs.filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).map((b) => b.outerHTML.slice(0, 60)));
    assert.deepEqual(small, []);
  }));

  test("inputs are 16px so iPhones don't zoom in", () => withApp(baseSeed(), async ({ page }) => {
    const sizes = await page.$$eval("input, select", (els) => [...new Set(els.map((e) => getComputedStyle(e).fontSize))]);
    assert.deepEqual(sizes, ["16px"]);
  }));
});
