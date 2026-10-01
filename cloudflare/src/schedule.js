export const BASE_URL = "https://tt.chuvsu.ru";
export const DAY_NAMES = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
export class ScheduleError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}
export const clean = (value) => value.replace(/\s+/gu, " ").trim();

export function isoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new ScheduleError("Такой даты нет. Отправь дату в формате ДД.ММ.ГГГГ.");
  }
  return date.toISOString().slice(0, 10);
}
export const dayNumber = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;
export const weekday = (iso) => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
export const addDays = (iso, days) => new Date((dayNumber(iso) + days) * 86400000).toISOString().slice(0, 10);
export const displayDate = (iso) => iso.split("-").reverse().join(".");

export function weekSet(expression) {
  const normalized = expression.replace(/[–—]/gu, "-").replace(/\s+/gu, "");
  if (!/^\d+(?:-\d+)?(?:[,;]\d+(?:-\d+)?)*$/u.test(normalized)) {
    throw new ScheduleError("Не удалось прочитать недели занятия на сайте.");
  }
  const weeks = new Set();
  for (const part of normalized.split(/[,;]/u)) {
    const bounds = part.split("-").map(Number);
    const start = bounds[0], end = bounds.at(-1);
    if (!(start >= 1 && start <= end && end <= 60)) throw new ScheduleError("Неизвестный диапазон учебных недель.");
    for (let week = start; week <= end; week++) weeks.add(week);
  }
  return [...weeks];
}

// Native HTMLRewriter parses HTML without evaluating the university's scripts.
// Text arrives in arbitrary chunks: separate text nodes, never split chunks of a node.
export async function parseTimetable(html, groupId) {
  let tableFound = false, login = false, semester = 0, ignored = 0;
  const body = [], slots = [], times = new Map();
  let slot = null, entry = null, special = null, timeLabel = null;
  const append = (parts, chunk) => {
    parts.push(chunk.text);
    if (chunk.lastInTextNode) parts.push(" ");
  };
  const entrySelector = ".tdd > table > tr > td";
  const tbodySelector = ".tdd > table > tbody > tr > td";
  const entries = {
    element(element) {
      if (!slot) return;
      const current = { parts: [], markers: [], notices: [] };
      slot.entries.push(current);
      entry = current;
      element.onEndTag(() => { entry = null; special = null; });
    },
    text(chunk) { if (entry) append(special ? special.parts : entry.parts, chunk); },
  };
  const marker = {
    element(element) {
      if (!entry || special) return;
      const current = { parts: [] };
      entry.markers.push(current);
      special = current;
      element.onEndTag(() => { special = null; });
    },
  };
  const notice = {
    element(element) {
      if (!entry || special) return;
      const current = { parts: [] };
      // Preserve its position if the div is an ordinary description, not a replacement.
      entry.parts.push(current);
      entry.notices.push(current);
      special = current;
      element.onEndTag(() => { special = null; });
    },
  };
  const rewriter = new HTMLRewriter()
    .on("body", { text(chunk) { if (!ignored) append(body, chunk); } })
    .on("script, style", { element(element) { ignored++; element.onEndTag(() => { ignored--; }); } })
    .on('form[id="authtt"]', { element() { login = true; } })
    .on('input[id="htype"]', { element(element) { semester = Number(element.getAttribute("value")); } })
    .on('table[id="groupstt"]', { element() { tableFound = true; } })
    .on('div[id^="trd"]', {
      element(element) {
        const id = element.getAttribute("id");
        if (!/^trd[1-6]t\d+$/u.test(id)) return;
        timeLabel = [];
        times.set(id, timeLabel);
        element.onEndTag(() => { timeLabel = null; });
      },
      text(chunk) { if (timeLabel) append(timeLabel, chunk); },
    })
    .on('table[id="groupstt"] td[id]', {
      element(element) {
        const match = new RegExp(`^td([1-6])t(\\d+)g${groupId}$`, "u").exec(element.getAttribute("id"));
        if (!match) return;
        slot = { weekday: Number(match[1]) - 1, number: Number(match[2]), parts: [], entries: [] };
        slots.push(slot);
        element.onEndTag(() => { slot = null; });
      },
      text(chunk) { if (slot) append(slot.parts, chunk); },
    })
    .on(entrySelector, entries).on(tbodySelector, entries)
    .on(`${entrySelector} sup`, marker).on(`${tbodySelector} sup`, marker)
    .on(`${entrySelector} > div`, notice).on(`${tbodySelector} > div`, notice);
  await rewriter.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })).arrayBuffer();
  if (!tableFound) throw new ScheduleError(login ? "Сайт не предоставил гостевой доступ. Попробуй позже." : "Не удалось найти таблицу расписания. Возможно, сайт изменился.");
  const text = clean(body.join(""));
  const group = /Группа\s+([^\s()]+)/u.exec(text);
  const date = new RegExp(`(\\d{1,2})\\s+(${MONTHS.join("|")})\\s+(\\d{4})\\s*г\\.`, "iu").exec(text);
  const week = /идет\s+(\d+)\s*(?:\*+\s*)?неделя/iu.exec(text);
  if (!group || !date || !week || !semester) throw new ScheduleError("Не удалось прочитать группу, дату или учебную неделю на сайте.");
  if (![1, 3].includes(semester)) throw new ScheduleError("Сейчас на сайте сессия или другой учебный период. Открой расписание на сайте.");
  const anchorDate = isoDate(Number(date[3]), MONTHS.indexOf(date[2].toLowerCase()) + 1, Number(date[1]));
  const anchorWeek = Number(week[1]);
  if (anchorWeek < 1 || anchorWeek > 30 || !slots.length) throw new ScheduleError("Таблица имеет неизвестную структуру; расписание не прочитано.");
  const lessons = [];
  for (const current of slots) {
    const time = /(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/u.exec((times.get(`trd${current.weekday + 1}t${current.number}`) || []).join(""));
    if (!time || (clean(current.parts.join("")) && !current.entries.length)) throw new ScheduleError("Структура или время занятия изменились; расписание не прочитано.");
    for (const item of current.entries) {
      const changes = [];
      for (const block of item.notices) {
        const note = clean(block.parts.join(""));
        const dates = [...new Set(note.match(/\b\d{2}\.\d{2}\.\d{4}\b/gu) || [])];
        block.replacement = dates.length > 0;
        for (const date of dates) {
          const [day, month, year] = date.split(".").map(Number);
          changes.push({ date: isoDate(year, month, day), text: note });
        }
      }
      let parity = null;
      for (const marker of item.markers) {
        const value = clean(marker.parts.join(""));
        if (value !== "*" && value !== "**") throw new ScheduleError("Неизвестная отметка недели у занятия.");
        parity = value === "*" ? 1 : 0;
      }
      let full = clean(item.parts.map((part) => typeof part === "string" ? part : part.replacement ? " " : part.parts.join("")).join(""));
      if (!full) throw new ScheduleError("На сайте обнаружено пустое описание занятия.");
      const weeks = /\(([^()]*)\s+нед\.?\)/iu.exec(full);
      if (/нед\.?/iu.test(full) && !weeks) throw new ScheduleError("Не удалось прочитать ограничение занятия по неделям.");
      const subgroup = /(\d+)\s*подгрупп/iu.exec(full);
      const subgroupNumber = subgroup ? Number(subgroup[1]) : null;
      if (subgroup && ![1, 2].includes(subgroupNumber)) throw new ScheduleError("Неизвестная подгруппа на сайте.");
      if (weeks) full = clean(full.slice(0, weeks.index) + full.slice(weeks.index + weeks[0].length));
      lessons.push({ weekday: current.weekday, number: current.number, start: time[1], end: time[2], text: full,
        weeks: weeks ? weekSet(weeks[1]) : null, parity, subgroup: subgroupNumber, changes });
    }
  }
  return { group: group[1], groupId, anchorDate, anchorWeek, semester, lessons };
}

export function weekFor(table, target) {
  return table.anchorWeek + ((dayNumber(target) - weekday(target)) - (dayNumber(table.anchorDate) - weekday(table.anchorDate))) / 7;
}
export function matchingLessons(table, target, subgroup = 0) {
  const week = weekFor(table, target);
  return table.lessons.filter((lesson) => lesson.weekday === weekday(target)
    && (!lesson.weeks || lesson.weeks.includes(week))
    && (lesson.parity === null || lesson.parity === week % 2)
    && (!subgroup || lesson.subgroup === null || lesson.subgroup === subgroup)).sort((a, b) => a.number - b.number);
}
function dayLines(table, target, subgroup, includeWeek = true) {
  const delta = dayNumber(target) - dayNumber(table.anchorDate), week = weekFor(table, target);
  if (delta < -7 || delta > 14 || !Number.isFinite(delta)) throw new ScheduleError("Можно посмотреть последнюю неделю и 14 дней вперёд.");
  if (week < 1 || week > 30) throw new ScheduleError("Для этой даты нельзя определить учебную неделю.");
  const lines = [`📅 ${DAY_NAMES[weekday(target)]}, ${displayDate(target)}`];
  if (includeWeek) lines.push(`Неделя ${week} · ${week % 2 ? "нечётная" : "чётная"} · ${subgroup ? `${subgroup}-я подгруппа` : "Все подгруппы"}`);
  lines.push("");
  const matches = matchingLessons(table, target, subgroup);
  let number = null;
  for (const lesson of matches) {
    if (number !== lesson.number) {
      if (number !== null) lines.push("");
      lines.push(`🕒 ${lesson.number} пара · ${lesson.start}–${lesson.end}`);
      number = lesson.number;
    }
    const notes = lesson.changes.filter((change) => change.date === target);
    lines.push((notes.length ? "Основное расписание: " : "") + lesson.text);
    for (const note of notes) lines.push(`⚠ ${note.text}`);
  }
  if (!matches.length) lines.push("По опубликованному расписанию занятий нет 🎉");
  return lines;
}
function footerLines(table) {
  const lines = [];
  if (table.snapshotFetchedAt) lines.push("", `⚠️ Показана сохранённая копия сайта от ${new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short" }).format(new Date(table.snapshotFetchedAt))} МСК. Она может быть устаревшей; проверь замены на сайте.`);
  lines.push("", "Замены показаны ниже соответствующей пары. Сайт может обновить расписание.", `Источник: ${BASE_URL}/index/grouptt/gr/${table.groupId}`);
  return lines;
}
export function renderTimetable(table, target, subgroup = 0) {
  return [`📚 ${table.group}`, ...dayLines(table, target, subgroup), ...footerLines(table)].join("\n");
}
export function renderWeek(table, today, subgroup = 0) {
  const monday = addDays(today, -weekday(today)), sunday = addDays(monday, 6), week = weekFor(table, monday);
  const lines = [`📚 ${table.group}`, `🗓 Расписание на неделю · ${displayDate(monday)}–${displayDate(sunday)}`,
    `Неделя ${week} · ${week % 2 ? "нечётная" : "чётная"} · ${subgroup ? `${subgroup}-я подгруппа` : "Все подгруппы"}`];
  for (let index = 0; index < 7; index++) lines.push("", ...dayLines(table, addDays(monday, index), subgroup, false));
  return [...lines, ...footerLines(table)].join("\n");
}

export class ScheduleClient {
  constructor(db, groupId, fetcher = fetch, now = Date.now, snapshotUrl = "") {
    this.db = db; this.groupId = groupId; this.fetcher = fetcher; this.now = now;
    this.url = `${BASE_URL}/index/grouptt/gr/${groupId}`;
    this.cookies = new Map();
    this.snapshotUrl = snapshotUrl;
  }
  async snapshot() {
    if (!/^https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/schedule-cache\/timetable\.json$/u.test(this.snapshotUrl)) throw new ScheduleError("Резервная копия расписания не настроена.");
    const fetcher = this.fetcher;
    const response = await fetcher(this.snapshotUrl, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new ScheduleError("Не удалось загрузить свежую копию расписания.");
    const reader = response.body.getReader(), chunks = []; let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > 1048576) { await reader.cancel(); throw new ScheduleError("Неизвестный формат копии расписания."); }
      chunks.push(value);
    }
    const data = JSON.parse(await new Response(new Blob(chunks)).text()), fetched = Date.parse(data.fetched_at), age = this.now() - fetched;
    if (data.version !== 1 || data.group_id !== this.groupId || data.source_url !== this.url || !Number.isFinite(age) || age < -300000
      || typeof data.html !== "string" || new TextEncoder().encode(data.html).length > 524288) throw new ScheduleError("Копия расписания имеет неизвестный формат. Попробуй позже.");
    const table = await parseTimetable(data.html, this.groupId);
    table.snapshotFetchedAt = data.fetched_at;
    return table;
  }
  async request(url, options = {}) {
    let method = options.method || "GET", body = options.body;
    for (let redirects = 0; redirects < 5; redirects++) {
      if (new URL(url).origin !== BASE_URL) throw new ScheduleError("Неожиданный адрес гостевого входа на сайте.");
      const headers = { "User-Agent": "ChuvsuScheduleBot/2.0", ...options.headers };
      if (this.cookies.size) headers.Cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
      const fetcher = this.fetcher;
      const response = await fetcher(url, { method, body, headers, redirect: "manual", signal: AbortSignal.timeout(15000) });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";", 1)[0], equal = pair.indexOf("=");
        if (equal > 0) this.cookies.set(pair.slice(0, equal), pair.slice(equal + 1));
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("Location");
        if (!location) throw new ScheduleError("Ошибка гостевого входа на сайте.");
        await response.body?.cancel();
        url = new URL(location, url).href;
        if ([301, 302, 303].includes(response.status)) { method = "GET"; body = undefined; }
        continue;
      }
      if (!response.ok) throw new ScheduleError("Сайт расписания сейчас недоступен. Попробуй позже.", response.status);
      // Bound an unexpected response before buffering it.
      const reader = response.body.getReader(), chunks = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 524288) { await reader.cancel(); throw new ScheduleError("Страница расписания имеет неизвестный формат."); }
        chunks.push(value);
      }
      const result = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      return new TextDecoder("utf-8", { fatal: true }).decode(result);
    }
    throw new ScheduleError("Не удалось открыть гостевое расписание.");
  }
  async get() {
    const key = `schedule:${this.groupId}`;
    const cached = await this.db.prepare("SELECT value FROM cache WHERE key=? AND expires_at>?").bind(key, this.now()).first();
    if (cached) return JSON.parse(cached.value);
    let table;
    try {
      let html = await this.request(this.url);
      if (/<form\b[^>]*\bid=["']authtt["']/iu.test(html)) {
        await this.request(`${BASE_URL}/auth`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ guest: "Войти гостем", wauto: "1", wname: "", wpass: "", pertt: "1" }).toString() });
        html = await this.request(this.url);
      }
      table = await parseTimetable(html, this.groupId);
    } catch (error) {
      // Only a transport/TLS failure allows the verified public snapshot. A
      // changed layout or denied guest login must never silently use old data.
      if (this.snapshotUrl && (!(error instanceof ScheduleError) || error.status === 526)) {
        try { table = await this.snapshot(); }
        catch (snapshotError) {
          if (snapshotError instanceof ScheduleError) throw snapshotError;
          throw new ScheduleError("Не удалось загрузить свежую копию расписания. Попробуй позже.");
        }
      } else if (error instanceof ScheduleError) throw error;
      // Fetch exceptions can contain URLs: do not log or propagate them.
      else throw new ScheduleError("Сайт расписания сейчас недоступен. Попробуй через несколько минут.");
    }
    await this.db.prepare("INSERT INTO cache(key,value,expires_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at")
      .bind(key, JSON.stringify(table), this.now() + 120000).run();
    return table;
  }
}
