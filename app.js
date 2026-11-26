import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm";
import { SUPABASE_URL, SUPABASE_KEY, USERNAME_EMAIL_DOMAIN } from "./config.js";
import {
  STALE_DAYS, esc, kindIcon, ymd, parseYmd, firstOfMonth, addMonths, daysAgo, agoText, slotForHour,
  activeDishes as active, findDish as find, suggestions, STALE_LIMIT, regularsList,
  scoreOptions, leader, voteAction, monthCells, groupByDay, sortBySlot, MACROS, calories, macroText, sumMacros, splitText, weekStart, addDays, weekSummary, parseGrams,
} from "./lib.js";

const app = document.getElementById("app");
const $ = (sel, root = document) => root.querySelector(sel);
const mount = (id) => { app.replaceChildren($(`#${id}`).content.cloneNode(true)); };

// One toast at a time, with an optional Undo. Replaces alert()/confirm().
let toastTimer;
function toast(msg, undo) {
  const t = $("#toast");
  t.replaceChildren(Object.assign(document.createElement("span"), { textContent: msg }));
  if (undo) {
    const b = Object.assign(document.createElement("button"), { textContent: "Undo", className: "link" });
    b.addEventListener("click", async () => { t.hidden = true; await undo(); });
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), undo ? 7000 : 4000);
}
const say = (msg) => toast(msg);
const showError = (el, err) => { el.textContent = err?.message ?? String(err); el.hidden = false; };

if (!SUPABASE_URL || !SUPABASE_KEY) {
  mount("tpl-setup");
  throw new Error("config.js is not filled in");
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const toEmail = (u) => `${u.trim().toLowerCase()}@${USERNAME_EMAIL_DOMAIN}`;

let state = {
  staleKind: "", staleAll: false, user: null, member: null, household: null, members: [], options: [], votes: [], groceries: [],
  dishes: [], eaten: [], calMonth: firstOfMonth(new Date()), calDay: ymd(new Date()),
};
let channel = null;

sb.auth.onAuthStateChange((_event, session) => {
  const uid = session?.user?.id ?? null;
  if (uid === state.user?.id) return;
  state.user = session?.user ?? null;
  route();
});

$("#logout").addEventListener("click", () => sb.auth.signOut());
app.addEventListener("click", onListClick);

async function route() {
  if (channel) { sb.removeChannel(channel); channel = null; }
  $("#who").hidden = !state.user;
  if (!state.user) return showAuth();

  const { data: member, error } = await sb.from("members").select("*").eq("user_id", state.user.id).maybeSingle();
  if (error) { app.textContent = error.message; return; }
  state.member = member;
  $("#who-name").textContent = member?.username ?? state.user.user_metadata?.username ?? "";
  if (!member) return showHousehold();
  showMain();
}

// ---------------------------------------------------------------- auth ----

function showAuth() {
  mount("tpl-auth");
  const form = $("#auth-form");
  const submit = $("button[type=submit]", form);
  const err = $(".error", form);
  let mode = "login";

  app.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.mode;
    app.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    submit.textContent = mode === "login" ? "Log in" : "Create account";
    form.password.autocomplete = mode === "login" ? "current-password" : "new-password";
    err.hidden = true;
  }));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    submit.disabled = true;
    const username = form.username.value.trim();
    const email = toEmail(username);
    const password = form.password.value;
    const { error } = mode === "login"
      ? await sb.auth.signInWithPassword({ email, password })
      : await sb.auth.signUp({ email, password, options: { data: { username } } });
    submit.disabled = false;
    if (error) {
      showError(err, error.message === "Invalid login credentials" ? new Error("Wrong username or password") : error);
    } else if (mode === "signup") {
      const { data } = await sb.auth.getSession();
      if (!data.session) showError(err, new Error("Account created, but email confirmation is on in Supabase. Turn it off (see README) and log in."));
    }
  });
}

// ----------------------------------------------------------- household ----

function showHousehold() {
  mount("tpl-household");
  const err = app.querySelector(":scope > .card > .error");
  const username = state.user.user_metadata?.username ?? state.user.email.split("@")[0];

  $("#create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await sb.rpc("create_household", { p_name: e.target.name.value, p_username: username });
    error ? showError(err, error) : route();
  });
  $("#join-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await sb.rpc("join_household", { p_code: e.target.code.value, p_username: username });
    error ? showError(err, error) : route();
  });
}

const slotForNow = () => slotForHour(new Date().getHours());

// ---------------------------------------------------------------- main ----

function showMain() {
  mount("tpl-main");

  app.querySelectorAll(".bottom-nav button").forEach((b) => b.addEventListener("click", () => {
    app.querySelectorAll(".bottom-nav button").forEach((x) => x.classList.toggle("active", x === b));
    app.querySelectorAll("[data-view]:not(button)").forEach((s) => (s.hidden = s.dataset.view !== b.dataset.view));
    window.scrollTo(0, 0);
  }));

  $("#option-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const name = f.name.value.trim();
    if (!name) return;
    const { error } = await sb.from("meal_options").insert({ name, kind: f.kind.value });
    if (error && error.code !== DUPLICATE) return say(error.message);
    f.reset();
    f.kindPicked = false;
    loadMeals();
    loadDishes();
  });
  // Option form: typing a known regular fills in home/out for you, unless you've
  // already picked 🏠/🍽️ yourself (so "Pizza" can be both a home and an out regular).
  const of = $("#option-form");
  of.kindPicked = false;
  of.kind.addEventListener("input", () => (of.kindPicked = true));
  of.name.addEventListener("input", () => {
    const dish = findDish(of.name.value);
    if (!dish || of.kindPicked) return;
    of.kind.value = dish.kind;
  });

  // Calendar form: pick a past meal from the list, or choose "New meal…" to type one.
  const ef = $("#eaten-form");
  ef.slot.value = slotForNow();
  const syncEaten = () => {
    const isNew = ef.dish.value === NEW;
    ef.name.hidden = !isNew; ef.name.required = isNew;
    ef.kind.hidden = !isNew;
    ef.place.hidden = !isNew || ef.kind.value !== "out";
    if (isNew) ef.name.focus();
  };
  ef.dish.addEventListener("change", syncEaten);
  ef.kind.addEventListener("change", syncEaten);
  ef.addEventListener("submit", async (e) => {
    e.preventDefault();
    const day = state.calDay;
    if (ef.dish.value !== NEW) {
      const dish = state.dishes.find((d) => d.id === ef.dish.value);
      if (dish) await logEaten(dish, { slot: ef.slot.value, eaten_on: day });
      return;
    }
    const name = ef.name.value.trim();
    if (!name) return;
    const kind = ef.kind.value;
    const place = kind === "out" ? (ef.place.value.trim() || null) : null;
    const { error } = await sb.from("meals_eaten").insert({ name, kind, place, slot: ef.slot.value, eaten_on: day });
    if (error) return say(error.code === DUPLICATE ? `Already logged for ${ef.slot.value} that day.` : error.message);
    ef.name.value = ""; ef.place.value = "";
    loadEaten();
    loadDishes();
  });

  app.querySelectorAll(".dish-form").forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = f.name.value.trim();
    if (!name) return;
    const { error } = await sb.rpc("ensure_dish", { p_name: name, p_kind: f.dataset.kind, p_place: f.place?.value.trim() || null });
    if (error) return say(error.message);
    f.reset();
    f.name.focus();
    loadDishes();
  }));

  $("#meal-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, err = $(".error", f);
    err.hidden = true;
    const name = f.name.value.trim();
    if (!name) return;
    let grams;
    try { grams = Object.fromEntries(MACROS.map(([k]) => [k, parseGrams(f[k].value)])); } catch (x) { return showError(err, x); }
    const { data: id, error } = await sb.rpc("ensure_dish", { p_name: name, p_kind: "home", p_place: null });
    if (error) return showError(err, error);
    if (Object.values(grams).some((v) => v != null)) {
      const { error: e2 } = await sb.from("dishes").update(grams).eq("id", id);
      if (e2) return showError(err, e2);
    }
    f.reset();
    f.name.focus();
    loadDishes();
  });

  $("#grocery-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    const qty = e.target.qty.value.trim() || null;
    if (!name) return;
    e.target.reset();
    e.target.name.focus();
    await sb.from("groceries").insert({ name, qty });
    loadGroceries();
  });

  $("#new-round").addEventListener("click", async () => {
    const ids = state.options.map((o) => o.id);
    if (!ids.length) return;
    await sb.from("meal_options").update({ status: "archived" }).in("id", ids);
    loadMeals();
    toast("Cleared the vote.", async () => {
      const { error } = await sb.from("meal_options").update({ status: "open" }).in("id", ids);
      if (error) say(error.message);
      loadMeals();
    });
  });

  const dlg = $("#dish-dialog"), df = $("#dish-form");
  $("#dish-cancel").addEventListener("click", () => dlg.close());
  df.addEventListener("submit", async (e) => {
    e.preventDefault();
    const dish = state.dishes.find((d) => d.id === df.dataset.id);
    const err = $(".error", df);
    if (!dish) return dlg.close();
    const name = df.name.value.trim();
    if (!name) return showError(err, new Error("Give it a name."));
    let grams;
    try { grams = Object.fromEntries(MACROS.map(([k]) => [k, parseGrams(df[k].value)])); } catch (x) { return showError(err, x); }
    const place = dish.kind === "out" ? (df.place.value.trim() || null) : null;
    const { error } = await sb.from("dishes").update({ name, place, ingredients: df.ingredients.value.trim() || null, ...grams }).eq("id", dish.id);
    if (error) return showError(err, error.code === DUPLICATE ? new Error(`"${name}" is already a regular.`) : error);
    dlg.close();
    loadDishes(); loadEaten(); loadMeals();
  });

  loadHousehold();
  loadMeals();
  loadGroceries();
  loadDishes();
  loadEaten();
  renderCalendar();

  channel = sb.channel("household")
    .on("postgres_changes", { event: "*", schema: "public", table: "meal_options" }, loadMeals)
    .on("postgres_changes", { event: "*", schema: "public", table: "votes" }, loadMeals)
    .on("postgres_changes", { event: "*", schema: "public", table: "groceries" }, loadGroceries)
    .on("postgres_changes", { event: "*", schema: "public", table: "dishes" }, loadDishes)
    .on("postgres_changes", { event: "*", schema: "public", table: "meals_eaten" }, loadEaten)
    .subscribe();
}

// Postgres unique_violation: the meal is already in the vote / already logged.
const DUPLICATE = "23505";
const NEW = "__new__";

// Every calendar entry and vote option points at one regular (dish_id); the
// database creates the regular when a new name is added anywhere.
const activeDishes = () => active(state.dishes);
const findDish = (name, kind) => find(state.dishes, name, kind);

async function logEaten(dish, { slot = slotForNow(), eaten_on = ymd(new Date()) } = {}) {
  const grams = Object.fromEntries(MACROS.map(([k]) => [k, dish[k] ?? null])); // frozen copy: later edits don't change this entry
  const { error } = await sb.from("meals_eaten").insert({ dish_id: dish.id, name: dish.name, kind: dish.kind, place: dish.place, slot, eaten_on, ...grams });
  const when = eaten_on === ymd(new Date()) ? "today's" : "that day's";
  if (error) say(error.code === DUPLICATE ? `${dish.name} is already logged for ${when} ${slot}.` : error.message);
  loadEaten();
}

async function suggestDish(dish) {
  const { error } = await sb.from("meal_options").insert({ dish_id: dish.id, name: dish.name, kind: dish.kind });
  if (error && error.code !== DUPLICATE) say(error.message);
  loadMeals();
}

async function onListClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const { act, id } = btn.dataset;
  const dish = id && state.dishes.find((d) => d.id === id);

  if (act === "vote") {
    const value = Number(btn.dataset.value);
    const mine = state.votes.find((v) => v.option_id === id && v.user_id === state.user.id);
    if (voteAction(mine?.value, value) === "remove") {
      await sb.from("votes").delete().eq("option_id", id).eq("user_id", state.user.id);
    } else {
      await sb.from("votes").upsert({ option_id: id, value });
    }
    loadMeals();
  } else if (act === "del-option") {
    const o = state.options.find((x) => x.id === id);
    await sb.from("meal_options").update({ status: "archived" }).eq("id", id);
    loadMeals();
    toast(`Removed ${o?.name ?? "suggestion"}.`, async () => {
      const { error } = await sb.from("meal_options").update({ status: "open" }).eq("id", id);
      if (error) say(error.message);
      loadMeals();
    });
  } else if (act === "choose") {
    const o = state.options.find((x) => x.id === id);
    await sb.from("meal_options").update({ status: "archived" }).eq("status", "open").neq("id", id);
    await sb.from("meal_options").update({ status: "chosen", decided_at: new Date().toISOString() }).eq("id", id);
    const d = state.dishes.find((x) => x.id === o?.dish_id);
    if (d) await logEaten(d);
    loadMeals();
  } else if (act === "tick-grocery") {
    const g = state.groceries.find((x) => x.id === id);
    if (!g) return;
    g.checked = !g.checked; // instant feedback; the reload below confirms it
    g.checked_at = g.checked ? new Date().toISOString() : null;
    renderGroceries();
    const { error } = await sb.from("groceries").update({ checked: g.checked, checked_at: g.checked_at }).eq("id", id);
    if (error) say(error.message);
    loadGroceries();
  } else if (act === "clear-ticked") {
    const rows = state.groceries.filter((g) => g.checked);
    if (!rows.length) return;
    await sb.from("groceries").delete().in("id", rows.map((g) => g.id));
    loadGroceries();
    toast(`Cleared ${rows.length} ticked item${rows.length > 1 ? "s" : ""}.`, async () => {
      const { error } = await sb.from("groceries").insert(rows.map(({ id, name, qty, checked, checked_at, created_at }) => ({ id, name, qty, checked, checked_at, created_at })));
      if (error) say(error.message);
      loadGroceries();
    });
  } else if (act === "stale-filter") {
    state.staleKind = btn.dataset.kind;
    state.staleAll = false;
    renderStale();
  } else if (act === "stale-more") {
    state.staleAll = !state.staleAll;
    renderStale();
  } else if (act === "surprise") {
    const pool = staleRows().filter((r) => !state.options.some((o) => o.dish_id === r.d.id)).slice(0, 3);
    if (!pool.length) return say("Nothing to pick from.");
    const pick = pool[Math.floor(Math.random() * pool.length)].d;
    await suggestDish(pick);
    toast(`Added ${pick.name} to the vote.`);
  } else if (act === "snooze") {
    const until = ymd(new Date(Date.now() + 7 * 864e5));
    await sb.from("dishes").update({ snoozed_until: until }).eq("id", id);
    loadDishes();
    toast(`Hiding ${dish?.name ?? "it"} for a week.`, async () => {
      const { error } = await sb.from("dishes").update({ snoozed_until: null }).eq("id", id);
      if (error) say(error.message);
      loadDishes();
    });
  } else if (act === "dish-vote" && dish) {
    await suggestDish(dish);
    btn.textContent = "✓";
  } else if (act === "dish-ate" && dish) {
    await logEaten(dish);
  } else if (act === "edit-dish" && dish) {
    const f = $("#dish-form");
    f.dataset.id = dish.id;
    f.name.value = dish.name;
    f.place.value = dish.place ?? "";
    f.place.parentElement.hidden = dish.kind !== "out";
    for (const [k] of MACROS) f[k].value = dish[k] ?? "";
    f.ingredients.value = dish.ingredients ?? "";
    $(".error", f).hidden = true;
    $("#dish-dialog").showModal();
  } else if (act === "del-dish" && dish) {
    await sb.from("dishes").update({ archived: true }).eq("id", id);
    loadDishes();
    toast(`Removed ${dish.name} from regulars.`, async () => {
      await sb.from("dishes").update({ archived: false }).eq("id", id);
      loadDishes();
    });
  } else if (act === "del-eaten") {
    const m = state.eaten.find((x) => x.id === id);
    await sb.from("meals_eaten").delete().eq("id", id);
    loadEaten();
    if (m) toast(`Removed ${m.name}.`, async () => {
      const { id, dish_id, name, kind, place, slot, eaten_on, carbs_g, protein_g, fat_g } = m;
      const { error } = await sb.from("meals_eaten").insert({ id, dish_id, name, kind, place, slot, eaten_on, carbs_g, protein_g, fat_g });
      if (error) say(error.message);
      loadEaten();
    });

  } else if (act === "week-prev" || act === "week-next") {
    state.calDay = addDays(state.calDay, act === "week-next" ? 7 : -7);
    state.calMonth = firstOfMonth(parseYmd(state.calDay));
    renderCalendar();
  } else if (act === "cal-prev" || act === "cal-next") {
    state.calMonth = addMonths(state.calMonth, act === "cal-next" ? 1 : -1);
    renderCalendar();
  } else if (act === "goto") {
    state.calDay = ymd(new Date());
    state.calMonth = firstOfMonth(new Date());
    renderCalendar();
    $(`.bottom-nav [data-view=${btn.dataset.view}]`).click();
  } else if (act === "cal-day") {
    state.calDay = btn.dataset.day;
    renderCalendar();
  }
}

async function loadHousehold() {
  const [{ data: hh }, { data: members }] = await Promise.all([
    sb.from("households").select("*").single(),
    sb.from("members").select("user_id, username").order("created_at"),
  ]);
  state.household = hh;
  state.members = members ?? [];
  $("#hh-name").textContent = hh?.name ?? "";
  $("#hh-code").textContent = hh?.join_code ?? "";
  $("#members").innerHTML = state.members.map((m) => `<li>${esc(m.username)}</li>`).join("");
  renderMeals();
}

// Vote options aren't eaten yet, so they show the regular's current macros...
const macroLine = (dishId) => macroText(state.dishes.find((d) => d.id === dishId));
// ...calendar entries show the macros saved when they were logged.
const totalsLine = (entries) => {
  const t = sumMacros(entries);
  return t ? `${macroText(t)}${splitText(t) ? ` (${splitText(t)})` : ""}` : "";
};

const nameOf = (uid) => state.members.find((m) => m.user_id === uid)?.username ?? "someone";

// ---------------------------------------------------------------- vote ----

async function loadMeals() {
  const [{ data: options }, { data: votes }] = await Promise.all([
    sb.from("meal_options").select("*").eq("status", "open").order("created_at"),
    sb.from("votes").select("*"),
  ]);
  state.options = options ?? [];
  state.votes = votes ?? [];
  renderMeals();
  renderStale();
}

function renderMeals() {
  if (!$("#options")) return;
  const scored = scoreOptions(state.options, state.votes, state.user.id);

  $("#options").innerHTML = scored.length ? scored.map((o) => `
    <li>
      <div class="grow">
        <div>${kindIcon(o.kind)} ${esc(o.name)}</div>
        ${macroLine(o.dish_id) ? `<div class="meta">${macroLine(o.dish_id)}</div>` : ""}
        <div class="voters">${o.vs.map((v) => `${v.value > 0 ? "👍" : "👎"} ${esc(nameOf(v.user_id))}`).join(" · ") || `suggested by ${esc(nameOf(o.created_by))}`}</div>
      </div>
      <div class="vote">
        <button data-act="vote" data-value="1" data-id="${o.id}" class="up ${o.mine === 1 ? "on" : ""}" aria-label="Vote yes">👍</button>
        <span class="score">${o.score}</span>
        <button data-act="vote" data-value="-1" data-id="${o.id}" class="down ${o.mine === -1 ? "on" : ""}" aria-label="Vote no">👎</button>
      </div>
      <button class="x" data-act="del-option" data-id="${o.id}" aria-label="Remove">✕</button>
    </li>`).join("") : `<li class="muted">No suggestions yet. Add one above, or pick from "It's been a while".</li>`;

  const top = leader(scored);
  $("#winner").innerHTML = top
    ? `<div><div class="muted small">Leading</div><strong>${kindIcon(top.kind)} ${esc(top.name)}</strong></div>
       <button class="primary" data-act="choose" data-id="${top.id}">We're eating this</button>`
    : "";
}

const staleRows = () => suggestions(state.dishes, state.eaten, state.groceries, ymd(new Date()),
  { kind: state.staleKind || null, slot: slotForNow() });

function staleReason({ last, typical, overdue, uses }) {
  const parts = [];
  if (uses.length) parts.push(`🛒 uses your ${uses.map((u) => u.name).slice(0, 2).join(", ")}${uses[0].age >= 3 ? ` (bought ${uses[0].age}d ago)` : ""}`);
  if (!last) parts.push("not had yet");
  else parts.push(overdue > 0 ? `${agoText(last)} · overdue by ${overdue} day${overdue > 1 ? "s" : ""}` : agoText(last));
  return parts.join(" · ");
}

function renderStale() {
  if (!$("#stale")) return;
  const all = staleRows();
  $("#stale-card").hidden = !activeDishes().length;
  for (const b of document.querySelectorAll("#stale-filter button")) b.setAttribute("aria-pressed", String(b.dataset.kind === state.staleKind));
  const rows = state.staleAll ? all : all.slice(0, STALE_LIMIT);
  $("#stale").innerHTML = rows.length ? rows.map((r) => {
    const { d } = r;
    const inVote = state.options.some((o) => o.dish_id === d.id);
    return `<li>
      <div class="grow">${kindIcon(d.kind)} ${esc(d.name)}${d.place ? ` <span class="meta">· ${esc(d.place)}</span>` : ""}
        <div class="meta">${esc(staleReason(r))}</div></div>
      <button data-act="dish-ate" data-id="${d.id}" title="We're eating this today">Eating this</button>
      <button data-act="dish-vote" data-id="${d.id}" ${inVote ? "disabled" : ""}>${inVote ? "✓ In vote" : "+ Vote"}</button>
      <button class="x" data-act="snooze" data-id="${d.id}" aria-label="Not now" title="Not now (hide for a week)">💤</button>
    </li>`;
  }).join("") : `<li class="muted">You've had all your regulars recently 🎉</li>`;
  $("#surprise").hidden = !all.length;
  const more = $("#stale-more");
  more.hidden = all.length <= STALE_LIMIT;
  more.textContent = state.staleAll ? "Show fewer" : `Show ${all.length - STALE_LIMIT} more`;
}

// ------------------------------------------------------------ regulars ----

async function loadDishes() {
  const { data } = await sb.from("dishes").select("*").order("name");
  state.dishes = data ?? [];
  renderDishes();
  renderStale();
  renderCalendar();
  renderEatenPicker();
  $("#dish-names").innerHTML = activeDishes().map((d) => `<option value="${esc(d.name)}">`).join("");
}

// Past meals (regulars) for the calendar form, grouped home/out, plus "New meal…".
function renderEatenPicker() {
  const sel = $("#eaten-form")?.dish;
  if (!sel) return;
  const keep = sel.value;
  const group = (kind, label) => {
    const rows = activeDishes().filter((d) => d.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
    return rows.length ? `<optgroup label="${label}">${rows.map((d) => `<option value="${d.id}">${esc(d.name)}${d.place ? ` · ${esc(d.place)}` : ""}</option>`).join("")}</optgroup>` : "";
  };
  sel.innerHTML = group("home", "🏠 At home") + group("out", "🍽️ Eat out") + `<option value="${NEW}">➕ New meal…</option>`;
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : (activeDishes().length ? sel.options[0].value : NEW);
  sel.dispatchEvent(new Event("change"));
}

// "Meals" tab: every home-cooked regular with its macros and calories on one row.
function renderMealBook() {
  const ul = $("#meal-book");
  if (!ul) return;
  const rows = activeDishes().filter((d) => d.kind === "home").sort((a, b) => a.name.localeCompare(b.name));
  ul.innerHTML = rows.length ? rows.map((d) => {
    const kcal = calories(d);
    return `<li>
      <div class="grow">${esc(d.name)}
        <div class="meta macros">${kcal == null ? `<button class="link" data-act="edit-dish" data-id="${d.id}">add macros</button>` : MACROS.map(([k, l]) => `${l} ${d[k] == null ? "–" : Math.round(d[k] * 10) / 10}`).join(" · ")}</div></div>
      <strong class="kcal">${kcal == null ? "" : `${kcal} kcal`}</strong>
      <button data-act="edit-dish" data-id="${d.id}" aria-label="Edit" title="Edit">✎</button>
      <button class="x" data-act="del-dish" data-id="${d.id}" aria-label="Remove">✕</button>
    </li>`;
  }).join("") : `<li class="muted">No meals yet. Add your first above.</li>`;
}

function renderDishes() {
  renderMealBook();
  for (const kind of ["home", "out"]) {
    const ul = $(`#dishes-${kind}`);
    if (!ul) continue;
    const rows = regularsList(state.dishes, state.eaten, kind);
    ul.innerHTML = rows.length ? rows.map(({ d, last }) => `
      <li>
        <div class="grow">${esc(d.name)}${d.place ? ` <span class="meta">· ${esc(d.place)}</span>` : ""}
          <div class="meta ${last && daysAgo(last) >= STALE_DAYS ? "stale" : ""}">${last ? `last had ${agoText(last)}` : "not had yet"}</div>
          ${macroText(d) ? `<div class="meta macros">${macroText(d)}</div>` : ""}</div>
        <button data-act="edit-dish" data-id="${d.id}" aria-label="Rename" title="Rename">✎</button>
        <button data-act="dish-vote" data-id="${d.id}" aria-label="Add to vote" title="Add to vote">🗳️</button>
        <button data-act="dish-ate" data-id="${d.id}" aria-label="We ate this today" title="We ate this today">✓</button>
        <button class="x" data-act="del-dish" data-id="${d.id}" aria-label="Remove">✕</button>
      </li>`).join("") : `<li class="muted">Nothing here yet.</li>`;
  }
}

// ------------------------------------------------------------ calendar ----

async function loadEaten() {
  const { data } = await sb.from("meals_eaten").select("*").order("eaten_on", { ascending: false }).order("created_at").limit(3000);
  state.eaten = data ?? [];
  renderCalendar();
  renderDishes();
  renderStale();
}

function renderToday() {
  if (!$("#today")) return;
  const meals = sortBySlot(groupByDay(state.eaten)[ymd(new Date())] ?? []);
  $("#today").innerHTML = meals.length ? meals.map((x) => {
    const place = x.place ?? state.dishes.find((d) => d.id === x.dish_id)?.place;
    return `<li><div class="grow">${kindIcon(x.kind)} ${esc(x.name)}${place ? ` <span class="meta">· ${esc(place)}</span>` : ""}
      ${macroText(x) ? `<div class="meta macros">${macroText(x)}</div>` : ""}</div>
      <span class="meta">${x.slot ? x.slot[0].toUpperCase() + x.slot.slice(1) : ""}</span></li>`;
  }).join("") + (totalsLine(meals) ? `<li class="total"><div class="grow meta">Total · ${totalsLine(meals)}</div></li>` : "") : `<li class="muted">Nothing logged yet today.</li>`;
}

function renderCalendar() {
  renderToday();
  if (!$("#cal-grid")) return;
  const m = state.calMonth;
  $("#cal-title").textContent = m.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const byDay = groupByDay(state.eaten);
  const today = ymd(new Date());
  const { blanks, cells } = monthCells(m, state.eaten);
  $("#cal-grid").innerHTML = [
    ...["S", "M", "T", "W", "T", "F", "S"].map((d) => `<div class="dow">${d}</div>`),
    ...Array.from({ length: blanks }, () => `<div></div>`),
    ...cells.map((c) => `<button data-act="cal-day" data-day="${c.key}" class="day ${c.key === today ? "today" : ""} ${c.key === state.calDay ? "sel" : ""}">
      <span class="num">${c.day}</span><span class="marks">${c.marks}</span></button>`),
  ].join("");

  const sel = parseYmd(state.calDay);
  $("#day-title").textContent = state.calDay === today ? "Today" : sel.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  const meals = sortBySlot(byDay[state.calDay] ?? []);
  $("#day-meals").innerHTML = meals.length ? meals.map((x) => {
    const place = x.place ?? state.dishes.find((d) => d.id === x.dish_id)?.place;
    return `
    <li>
      <div class="grow">${kindIcon(x.kind)} ${esc(x.name)}${place ? ` <span class="meta">· ${esc(place)}</span>` : ""}
        <div class="meta">${x.slot ? x.slot[0].toUpperCase() + x.slot.slice(1) : ""}${macroText(x) ? ` · ${macroText(x)}` : ""}</div></div>
      <button class="x" data-act="del-eaten" data-id="${x.id}" aria-label="Remove">✕</button>
    </li>`;
  }).join("") + (totalsLine(meals) ? `<li class="total"><div class="grow meta">Day total · ${totalsLine(meals)}</div></li>` : "") : `<li class="muted">Nothing logged.</li>`;
  renderWeek();
}

function renderWeek() {
  if (!$("#week")) return;
  const start = weekStart(state.calDay);
  const w = weekSummary(state.eaten, start);
  const fmtDay = (k) => parseYmd(k).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  $("#week-title").textContent = `${fmtDay(start)} – ${fmtDay(addDays(start, 6))}`;
  const grams = (t) => (t ? `C ${Math.round(t.carbs_g)} · P ${Math.round(t.protein_g)} · F ${Math.round(t.fat_g)}` : "");
  $("#week").innerHTML = w.days.map((d) => `
    <li class="${d.key === state.calDay ? "sel" : ""}">
      <button class="link" data-act="cal-day" data-day="${d.key}">${parseYmd(d.key).toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}</button>
      <span class="grow meta">${d.totals ? grams(d.totals) : d.meals.length ? "no macros" : "–"}</span>
      <strong>${d.kcal != null ? `${d.kcal} kcal` : ""}</strong>
    </li>`).join("") + (w.totals ? `
    <li class="total"><div class="grow meta">Week · ${macroText(w.totals)}<br>${splitText(w.totals)}${w.avg != null ? ` · avg ${w.avg} kcal/day (${w.logged} day${w.logged > 1 ? "s" : ""})` : ""}</div></li>` : "");
}

// ----------------------------------------------------------- groceries ----

async function loadGroceries() {
  const { data } = await sb.from("groceries").select("*").order("created_at", { ascending: false });
  state.groceries = data ?? [];
  renderGroceries();
  renderStale();
}

function renderGroceries() {
  if (!$("#groceries")) return;
  // Ticked items sink to the bottom; each group stays newest first.
  const rows = [...state.groceries.filter((g) => !g.checked), ...state.groceries.filter((g) => g.checked)];
  $("#groceries").innerHTML = rows.length ? rows.map((g) => `
    <li class="${g.checked ? "done" : ""}">
      <button class="tick" data-act="tick-grocery" data-id="${g.id}" aria-pressed="${!!g.checked}" aria-label="${g.checked ? "Untick" : "Tick off"} ${esc(g.name)}">${g.checked ? "✓" : ""}</button>
      <div class="grow">${esc(g.name)}${g.qty ? ` <span class="meta">· ${esc(g.qty)}</span>` : ""}
        <div class="meta">added ${new Date(g.created_at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</div>
      </div>
    </li>`).join("") : `<li class="muted">Nothing logged yet.</li>`;
  $("#clear-ticked").hidden = !state.groceries.some((g) => g.checked);
}
