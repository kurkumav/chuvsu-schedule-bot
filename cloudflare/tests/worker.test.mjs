import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const html = await readFile(new URL("../../tests/fixtures/group_8075_2026-09-29.html", import.meta.url), "utf8");
const schema = await readFile(new URL("../migrations/0001_state.sql", import.meta.url), "utf8");
const token = "123456:TEST_ONLY_FAKE_TELEGRAM_TOKEN", secret = "test_webhook_secret_at_least_32_characters";
const now = Date.parse("2026-09-29T03:59:00Z");
let mf, db, messages, calls, siteCalls, siteFails, siteRedirect, telegramCode, telegramDelay, snapshot;
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: ["tests/worker.js", "src/index.js", "src/bot.js", "src/schedule.js"].map((name) => ({ type: "ESModule", path: fileURLToPath(new URL(`../${name}`, import.meta.url)) })),
    compatibilityDate: "2026-09-29", d1Databases: { DB: "test-db" },
    bindings: { BOT_TOKEN: token, WEBHOOK_SECRET: secret, GROUP_ID: "8075", DAILY_TIME: "07:00", BOT_TIMEZONE: "Europe/Moscow" },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.hostname === "raw.githubusercontent.com") return snapshot ? Response.json(snapshot) : new Response("Not found", { status: 404 });
      if (url.hostname === "api.telegram.org") {
        const method = url.pathname.split("/").at(-1), data = await request.json();
        calls.push({ method, data });
        if (telegramDelay) await new Promise((resolve) => setTimeout(resolve, telegramDelay));
        if (telegramCode) return Response.json({ ok: false, error_code: telegramCode, description: `fake failure ${token}`, parameters: { retry_after: 60 } }, { status: telegramCode });
        if (method === "sendMessage") messages.push(data);
        return Response.json({ ok: true, result: true });
      }
      if (url.hostname === "tt.chuvsu.ru") {
        siteCalls.push({ url: request.url, method: request.method, cookie: request.headers.get("Cookie"), body: request.method === "POST" ? await request.text() : "" });
        if (siteFails) return new Response("outage", { status: typeof siteFails === "number" ? siteFails : 503 });
        if (siteRedirect && url.pathname.startsWith("/index/") && !request.headers.get("Cookie")?.includes("guest=yes")) return new Response(null, { status: 302, headers: { Location: siteRedirect, "Set-Cookie": "session=fake; Path=/" } });
        if (siteRedirect && url.pathname === "/auth" && request.method === "POST") return new Response(null, { status: 302, headers: { Location: "/index/grouptt/gr/8075", "Set-Cookie": "guest=yes; Path=/; Secure" } });
        if (url.pathname === "/auth" && request.method === "POST") return new Response("guest ok", { headers: { "Set-Cookie": "guest=yes; Path=/; Secure" } });
        if (!request.headers.get("Cookie")?.includes("guest=yes")) return new Response('<form id="authtt"></form>', { headers: { "Set-Cookie": "session=fake; Path=/" } });
        return new Response(html);
      }
      throw new Error("Unexpected network destination");
    },
  }));
  db = await mf.getD1Database("DB");
  for (const sql of schema.split(";").map((part) => part.trim()).filter(Boolean)) await db.prepare(sql).run();
});
after(async () => { await mf?.dispose(); });
beforeEach(async () => {
  messages = []; calls = []; siteCalls = []; siteFails = false; siteRedirect = null; telegramCode = 0; telegramDelay = 0;
  snapshot = null;
  await db.batch(["DELETE FROM users", "DELETE FROM updates", "DELETE FROM cache"].map((sql) => db.prepare(sql)));
});
async function post(path, body, headers = {}) {
  return mf.dispatchFetch(`https://worker.test${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
async function helper(path, body) {
  const response = await post(`/__test/${path}`, body), payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}
function message(text, id = 42, type = "private") { return { message: { chat: { id, type }, from: { id }, text } }; }
async function handle(text, timestamp = now) { return helper("handle", { update: message(text), now: timestamp }); }
async function callback(data) { return helper("handle", { now, update: { callback_query: { id: "fake_callback", from: { id: 42 }, message: { chat: { id: 42, type: "private" } }, data } } }); }
async function user(id = 42) { return db.prepare("SELECT * FROM users WHERE chat_id=?").bind(id).first(); }

test("native parser preserves metadata, odd/even weeks, subgroup and individual weeks", async () => {
  const queries = [
    { date: "2026-09-29" }, { date: "2026-09-29", subgroup: 1 }, { date: "2026-09-29", subgroup: 2 },
    { date: "2026-09-30", subgroup: 1 }, { date: "2026-09-30", subgroup: 2 },
    { date: "2026-10-06" }, { date: "2026-10-03" }, { date: "2026-10-10" }, { date: "2026-10-04" }, { date: "2026-10-05" },
  ];
  const result = await helper("parse", { html, queries });
  assert.equal(result.table.group, "ИВТ-13-23"); assert.equal(result.table.anchorDate, "2026-09-29"); assert.equal(result.table.anchorWeek, 5);
  assert.deepEqual(result.queries.slice(0, 9).map((query) => query.numbers), [[4, 5, 6, 7, 8], [4, 5], [6, 7, 8], [2, 3, 4, 5], [2, 3], [2, 3, 3], [1, 2], [1, 2, 3], []]);
  assert.equal(result.queries[8].week, 5); assert.equal(result.queries[9].week, 6);
});
test("replacement only appears for its date and subgroup", async () => {
  const result = await helper("parse", { html, queries: [{ date: "2026-10-01", subgroup: 1 }, { date: "2026-10-08", subgroup: 1 }, { date: "2026-10-01", subgroup: 2 }] });
  assert.match(result.queries[0].text, /Основное расписание: Г-402/u);
  assert.match(result.queries[0].text, /⚠ 01\.10\.2026 замена на: Аудитория: Б-202/u);
  assert.ok(result.queries.slice(1).every((query) => !query.text.includes("Б-202")));
});
test("changed layout, login, session and out-of-range dates give errors", async () => {
  for (const broken of ['<form id="authtt"></form>', html.replace('id="groupstt"', 'id="different"'), html.replaceAll('class="tdd"', 'class="changed"'), html.replace('value="1" id="htype"', 'value="2" id="htype"')]) {
    assert.equal((await post("/__test/parse", { html: broken })).status, 422);
  }
  assert.equal((await post("/__test/parse", { html, queries: [{ date: "2026-12-01" }] })).status, 422);
});
test("guest login uses /auth, cookies and persistent D1 cache", async () => {
  await helper("site", { now }); await helper("site", { now: now + 1000 });
  assert.equal(siteCalls.length, 3); assert.equal(siteCalls[1].url, "https://tt.chuvsu.ru/auth"); assert.equal(siteCalls[1].method, "POST");
  assert.match(siteCalls[1].body, /guest=/u); assert.match(siteCalls[2].cookie, /guest=yes/u);
  await helper("site", { now: now + 120001 }); assert.equal(siteCalls.length, 6);
});
test("real guest redirect sequence preserves cookies; off-site redirects stop before transmission", async () => {
  siteRedirect = "/auth";
  await helper("site", { now });
  assert.deepEqual(siteCalls.map((call) => call.method), ["GET", "GET", "POST", "GET", "GET"]);
  assert.match(siteCalls[3].cookie, /guest=yes/u);
  await db.prepare("DELETE FROM cache").run(); siteCalls = []; siteRedirect = "https://untrusted.test/capture";
  const response = await post("/__test/site", { now });
  assert.equal(response.status, 422); assert.match((await response.json()).error, /Неожиданный адрес/u); assert.equal(siteCalls.length, 1);
});
test("buttons, date selection, subgroup persist in D1", async () => {
  await callback("group:1"); await handle("📅 Расписание на сегодня");
  assert.match(messages.at(-1).text, /29\.09\.2026/u); assert.ok(!messages.at(-1).text.includes("2 подгруппа"));
  await handle("🌅 Расписание на завтра"); assert.match(messages.at(-1).text, /30\.09\.2026/u);
  await callback("day:2026-10-01"); assert.match(messages.at(-1).text, /Б-202/u); assert.equal((await user()).subgroup, 1);
  await handle("/days"); assert.equal(messages.at(-1).reply_markup.inline_keyboard.flat().length, 14);
  await handle("/start"); assert.equal(messages.at(-1).reply_markup.keyboard[0][0].text, "📅 Расписание на сегодня");
  assert.equal(messages.at(-1).reply_markup.keyboard[0][1].text, "🗓 Расписание на неделю");
});
test("week button shows Monday through Sunday with subgroup and replacements from one site read", async () => {
  await callback("group:1"); messages = [];
  await handle("🗓 Расписание на неделю");
  const result = messages.map((item) => item.text).join("\n");
  assert.match(result, /28\.09\.2026–04\.10\.2026/u);
  assert.equal((result.match(/📅 (?:Понедельник|Вторник|Среда|Четверг|Пятница|Суббота|Воскресенье),/gu) || []).length, 7);
  assert.match(result, /⚠ 01\.10\.2026 замена на: Аудитория: Б-202/u);
  assert.match(result, /Воскресенье, 04\.10\.2026\n\nПо опубликованному расписанию занятий нет/u);
  assert.ok(!result.includes("2 подгруппа"));
  assert.equal(siteCalls.length, 3);
  messages = [];
  await handle("/week", now + 5 * 86400000);
  assert.match(messages.map((item) => item.text).join("\n"), /28\.09\.2026–04\.10\.2026/u);
});
test("invalid and old dates do not fetch or falsely say no classes", async () => {
  await handle("31.02.2026"); assert.match(messages.at(-1).text, /Такой даты нет/u);
  await callback("day:2026-12-25"); assert.match(messages.at(-1).text, /Выбери новую дату/u); assert.equal(siteCalls.length, 0);
  siteFails = true; await handle("/today"); assert.match(messages.at(-1).text, /недоступен/u); assert.ok(!messages.at(-1).text.includes("занятий нет"));
});
test("private chats only; daily subscription is opt-in", async () => {
  await helper("handle", { now, update: message("/today", 42, "group") });
  await helper("daily", { now: now + 60000 }); assert.equal(messages.length, 0);
});
test("allowlist blocks strangers and old unauthorized subscribers cannot starve the owner", async () => {
  await helper("handle", { now, allowed: [42], update: message("/start", 99) }); assert.equal(messages.length, 0);
  await db.batch([1, 2, 3, 4, 5, 42].map((id) => db.prepare("INSERT INTO users(chat_id,subscribed) VALUES (?,1)").bind(id)));
  await helper("daily", { now: now + 60000, allowed: [42] });
  assert.equal(messages.length, 1); assert.equal(messages[0].chat_id, 42);
});
test("daily waits for 07:00 Moscow, persists success and atomically handles concurrent crons", async () => {
  await handle("/subscribe"); messages = [];
  await helper("daily", { now }); assert.equal(messages.length, 0);
  await helper("daily", { now: now + 60000, concurrent: 2 }); assert.equal(messages.length, 1);
  assert.equal((await user()).last_sent, "2026-09-29");
  await helper("daily", { now: now + 300000 }); assert.equal(messages.length, 1);
  await helper("daily", { now: now + 86460000 }); assert.equal(messages.length, 2);
});
test("subscribe after 07:00 starts tomorrow, repeated click keeps first date", async () => {
  await handle("/subscribe", now + 60000); assert.equal((await user()).since_date, "2026-09-30");
  await handle("/subscribe", now + 86460000); assert.equal((await user()).since_date, "2026-09-30");
  messages = []; await helper("daily", { now: now + 300000 }); assert.equal(messages.length, 0);
  await handle("/unsubscribe"); assert.equal((await user()).subscribed, 0);
});
test("site and Telegram failures retry, blocked users unsubscribe", async () => {
  await handle("/subscribe"); messages = []; siteFails = true;
  await helper("daily", { now: now + 60000 }); assert.equal((await user()).last_sent, null); assert.equal(messages.length, 0);
  siteFails = false; telegramCode = 500;
  await helper("daily", { now: now + 360001 }); assert.equal((await user()).last_sent, null);
  telegramCode = 403; await helper("daily", { now: now + 660002 }); assert.equal((await user()).subscribed, 0);
});
test("webhook authenticates secret before writes; rejects oversized or malformed input", async () => {
  const update = { update_id: 101, ...message("/start") }, header = { "X-Telegram-Bot-Api-Secret-Token": secret };
  assert.equal((await post("/telegram", update)).status, 403);
  assert.equal((await post("/telegram", update, { "X-Telegram-Bot-Api-Secret-Token": "wrong" })).status, 403);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM updates").first()).n, 0);
  assert.equal((await post("/telegram", { ...update, junk: "x".repeat(131073) }, header)).status, 400);
  assert.equal((await post("/telegram", { update_id: "101" }, header)).status, 400);
  assert.equal((await post("/telegram", update, header)).status, 200); assert.equal(messages.length, 1);
  assert.equal((await post("/telegram", update, header)).status, 200); assert.equal(messages.length, 1);
});
test("concurrent webhook retry does not duplicate answer; Telegram failure remains retryable", async () => {
  const header = { "X-Telegram-Bot-Api-Secret-Token": secret }, update = { update_id: 102, ...message("/start") };
  telegramDelay = 100;
  const responses = await Promise.all([post("/telegram", update, header), post("/telegram", update, header)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 503]); assert.equal(messages.length, 1);
  telegramDelay = 0; telegramCode = 500;
  const second = { ...update, update_id: 103 };
  assert.equal((await post("/telegram", second, header)).status, 500);
  telegramCode = 0; assert.equal((await post("/telegram", second, header)).status, 200); assert.equal(messages.length, 2);
});
test("UTF-16 split, week expressions and midnight Moscow date", async () => {
  const text = "📚".repeat(5000), result = await helper("utilities", { weeks: "2 - 4, 7; 9–10", text, now: Date.parse("2026-09-29T21:01:00Z") });
  assert.deepEqual(result.weeks, [2, 3, 4, 7, 9, 10]); assert.equal(result.pieces.join(""), text); assert.ok(result.pieces.every((piece) => piece.length <= 3500));
  assert.deepEqual(result.time, { date: "2026-09-30", time: "00:01" });
});
test("network failures do not expose Telegram token in responses", async () => {
  telegramCode = 401;
  const response = await post("/telegram", { update_id: 104, ...message("/start") }, { "X-Telegram-Bot-Api-Secret-Token": secret });
  assert.equal(response.status, 500); assert.ok(!(await response.text()).includes(token));
});
test("health verifies schema and reveals no users or secrets", async () => {
  const response = await mf.dispatchFetch("https://worker.test/health"); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
});
test("remote schedule probe requires secret, checks guest access and sends no Telegram messages", async () => {
  assert.equal((await post("/check", {})).status, 403);
  const header = { "X-Telegram-Bot-Api-Secret-Token": secret };
  const response = await post("/check", {}, header);
  assert.equal(response.status, 200); assert.equal((await response.json()).group, "ИВТ-13-23"); assert.equal(messages.length, 0);
  await db.prepare("DELETE FROM cache").run(); siteFails = true;
  assert.equal((await post("/check", {}, header)).status, 503); assert.equal(messages.length, 0);
});
const snapshotUrl = "https://raw.githubusercontent.com/kurkumav/chuvsu-schedule-bot/schedule-cache/timetable.json";
const freshSnapshot = () => ({ version: 1, group_id: 8075, source_url: "https://tt.chuvsu.ru/index/grouptt/gr/8075", fetched_at: new Date(now - 900000).toISOString(), html });
test("TLS 526 uses a fresh public snapshot, preserves lessons and labels its time", async () => {
  siteFails = 526; snapshot = freshSnapshot();
  const table = await helper("site", { now, snapshotUrl });
  assert.equal(table.snapshotFetchedAt, snapshot.fetched_at);
  const response = await helper("parse", { html: snapshot.html, queries: [{ date: "2026-09-29", subgroup: 1 }] });
  assert.deepEqual(response.queries[0].numbers, [4, 5]);
  await helper("handle", { now, snapshotUrl, update: message("/today") });
  assert.match(messages.at(-1).text, /Показана сохранённая копия сайта/u);
});
test("snapshot older than three hours still answers and remains cached for two minutes", async () => {
  siteFails = 526;
  snapshot = { ...freshSnapshot(), fetched_at: new Date(now - 3 * 86400000).toISOString() };
  await helper("handle", { now, snapshotUrl, update: message("/today") });
  assert.match(messages.at(-1).text, /⚠️ Показана сохранённая копия сайта/u);
  const cache = await db.prepare("SELECT expires_at FROM cache WHERE key='schedule:8075'").first();
  assert.equal(cache.expires_at, now + 120000);
});
test("week view labels an old snapshot once", async () => {
  siteFails = 526; snapshot = { ...freshSnapshot(), fetched_at: new Date(now - 3 * 86400000).toISOString() };
  await helper("handle", { now, snapshotUrl, update: message("/week") });
  const result = messages.map((item) => item.text).join("\n");
  assert.equal((result.match(/Показана сохранённая копия сайта/gu) || []).length, 1);
  assert.match(result, /Воскресенье, 04\.10\.2026/u);
});
test("snapshot refuses future timestamps, other groups, login HTML and unexpected destinations", async () => {
  siteFails = 526;
  for (const change of [{ fetched_at: new Date(now + 300001).toISOString() }, { fetched_at: "invalid" }, { group_id: 999 }, { source_url: "https://example.com" }, { html: '<form id="authtt"></form>' }]) {
    snapshot = { ...freshSnapshot(), ...change };
    assert.equal((await post("/__test/site", { now, snapshotUrl })).status, 422);
  }
  snapshot = freshSnapshot();
  assert.equal((await post("/__test/site", { now, snapshotUrl: "https://example.com/timetable.json" })).status, 422);
  siteFails = 503;
  assert.equal((await post("/__test/site", { now, snapshotUrl })).status, 422);
});
