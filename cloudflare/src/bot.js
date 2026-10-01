import { ScheduleError, addDays, dayNumber, displayDate, isoDate, renderTimetable, renderWeek, weekday } from "./schedule.js";

export const TODAY = "📅 Расписание на сегодня", TOMORROW = "🌅 Расписание на завтра", WEEK = "🗓 Расписание на неделю";
const PICK = "🗓 Выбрать день", GROUP = "👥 Подгруппа", SUBSCRIBE = "🔔 Ежедневная рассылка", STOP = "🔕 Отключить рассылку";
export const KEYBOARD = { keyboard: [[{ text: TODAY }, { text: WEEK }], [{ text: TOMORROW }, { text: PICK }],
  [{ text: GROUP }, { text: SUBSCRIBE }], [{ text: STOP }]], resize_keyboard: true, is_persistent: true };
const formatters = new Map();
export function localTime(milliseconds, zone = "Europe/Moscow") {
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }));
  const values = Object.fromEntries(formatters.get(zone).formatToParts(new Date(milliseconds)).map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}
export function configuration(env) {
  const dailyTime = env.DAILY_TIME || "07:00", zone = env.BOT_TIMEZONE || "Europe/Moscow", groupId = Number(env.GROUP_ID || "8075");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(dailyTime) || !Number.isSafeInteger(groupId) || groupId <= 0) throw new Error("Invalid configuration");
  localTime(Date.now(), zone);
  const allowed = (env.ALLOWED_USER_IDS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (allowed.some((value) => !/^\d+$/u.test(value))) throw new Error("Invalid allowlist");
  return { dailyTime, zone, groupId, allowed: new Set(allowed.map(Number)) };
}
export function chunks(text, limit = 3500) {
  const pieces = [];
  let current = "";
  for (const character of text) {
    if (current.length + character.length > limit) {
      const split = current.lastIndexOf("\n");
      if (split >= limit / 2) { pieces.push(current.slice(0, split)); current = current.slice(split + 1); }
      else { pieces.push(current); current = ""; }
    }
    current += character;
  }
  if (current) pieces.push(current);
  return pieces;
}
export class TelegramError extends Error {
  constructor(code = 0, retryAfter = 60) { super(`Telegram error (${code})`); this.code = code; this.retryAfter = retryAfter; }
}
export class Telegram {
  constructor(token, fetcher = fetch) { this.token = token; this.fetcher = fetcher; }
  async call(method, parameters = {}) {
    let response, payload;
    try {
      const fetcher = this.fetcher;
      response = await fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parameters), signal: AbortSignal.timeout(20000),
      });
      payload = await response.json();
    } catch { throw new TelegramError(); }
    if (!payload.ok) throw new TelegramError(Number(payload.error_code) || response.status, Math.max(1, Number(payload.parameters?.retry_after) || 60));
    return payload.result;
  }
  async send(chatId, text, markup = KEYBOARD) {
    const pieces = chunks(text);
    for (let index = 0; index < pieces.length; index++) await this.call("sendMessage", {
      chat_id: chatId, text: pieces[index], reply_markup: index === pieces.length - 1 ? markup : undefined,
      link_preview_options: { is_disabled: true },
    });
  }
}

export class Store {
  constructor(db) { this.db = db; }
  async user(chatId) {
    await this.db.prepare("INSERT OR IGNORE INTO users(chat_id) VALUES (?)").bind(chatId).run();
    return this.db.prepare("SELECT * FROM users WHERE chat_id=?").bind(chatId).first();
  }
  async subgroup(chatId, subgroup) {
    await this.user(chatId);
    await this.db.prepare("UPDATE users SET subgroup=? WHERE chat_id=?").bind(subgroup, chatId).run();
  }
  async subscribe(chatId, enabled, since = null) {
    await this.user(chatId);
    // Repeated subscribe must not move the first delivery date.
    if (enabled) await this.db.prepare("UPDATE users SET subscribed=1,since_date=? WHERE chat_id=? AND subscribed=0").bind(since, chatId).run();
    else await this.db.prepare("UPDATE users SET subscribed=0,since_date=NULL WHERE chat_id=?").bind(chatId).run();
  }
  async claimUpdate(id, now, token) {
    const result = await this.db.prepare(`INSERT INTO updates(update_id,done,lease_until,lease_token,created_at) VALUES (?,0,?,?,?)
      ON CONFLICT(update_id) DO UPDATE SET lease_until=excluded.lease_until,lease_token=excluded.lease_token
      WHERE updates.done=0 AND updates.lease_until<=? RETURNING update_id`).bind(id, now + 300000, token, now, now).first();
    if (result) return "claimed";
    const existing = await this.db.prepare("SELECT done FROM updates WHERE update_id=?").bind(id).first();
    return existing?.done ? "done" : "busy";
  }
  async finishUpdate(id, token, success) {
    await this.db.prepare("UPDATE updates SET done=?,lease_until=0 WHERE update_id=? AND lease_token=?").bind(success ? 1 : 0, id, token).run();
  }
  async due(target, now, allowed = new Set()) {
    const ids = [...allowed], filter = ids.length ? ` AND chat_id IN (${ids.map(() => "?").join(",")})` : "";
    return (await this.db.prepare(`SELECT * FROM users WHERE subscribed=1 AND (last_sent IS NULL OR last_sent<>?)
      AND (since_date IS NULL OR since_date<=?) AND lease_until<=?${filter} ORDER BY chat_id LIMIT 5`).bind(target, target, now, ...ids).all()).results;
  }
  async claimDelivery(chatId, target, now, token) {
    return this.db.prepare(`UPDATE users SET lease_until=?,lease_token=? WHERE chat_id=? AND subscribed=1
      AND (last_sent IS NULL OR last_sent<>?) AND (since_date IS NULL OR since_date<=?) AND lease_until<=? RETURNING *`)
      .bind(now + 300000, token, chatId, target, target, now).first();
  }
  async finishDelivery(chatId, target, token) {
    await this.db.prepare("UPDATE users SET last_sent=?,lease_until=0,lease_token=NULL WHERE chat_id=? AND lease_token=?").bind(target, chatId, token).run();
  }
  async retryDelivery(chatId, retryAt, token) {
    await this.db.prepare("UPDATE users SET lease_until=?,lease_token=NULL WHERE chat_id=? AND lease_token=?").bind(retryAt, chatId, token).run();
  }
  async cleanup(now) {
    await this.db.prepare("DELETE FROM updates WHERE created_at<? AND lease_until<=?").bind(now - 7 * 86400000, now).run();
  }
}

export class Bot {
  constructor(config, telegram, schedule, store, now = Date.now) { Object.assign(this, { config, telegram, schedule, store, now }); }
  authorized(id) { return Number.isSafeInteger(id) && (this.config.allowed.size === 0 || this.config.allowed.has(id)); }
  async showDay(chatId, target) {
    const today = localTime(this.now(), this.config.zone).date, delta = dayNumber(target) - dayNumber(today);
    if (!Number.isFinite(delta) || delta < -7 || delta > 14) {
      await this.telegram.send(chatId, "Выбери новую дату: доступны последняя неделя и 14 дней вперёд."); return;
    }
    let text;
    try { text = renderTimetable(await this.schedule.get(), target, (await this.store.user(chatId)).subgroup); }
    catch (error) {
      if (!(error instanceof ScheduleError)) throw error;
      text = `⚠ ${error.message}\n\n${this.schedule.url}`;
    }
    await this.telegram.send(chatId, text);
  }
  async showWeek(chatId, today) {
    let text;
    try { text = renderWeek(await this.schedule.get(), today, (await this.store.user(chatId)).subgroup); }
    catch (error) {
      if (!(error instanceof ScheduleError)) throw error;
      text = `⚠ ${error.message}\n\n${this.schedule.url}`;
    }
    await this.telegram.send(chatId, text);
  }
  async handle(update) {
    if (update.callback_query) { await this.callback(update.callback_query); return; }
    const message = update.message;
    if (message?.chat?.type !== "private" || !this.authorized(message?.from?.id) || !Number.isSafeInteger(message.chat.id)) return;
    const chatId = message.chat.id, text = (typeof message.text === "string" ? message.text : "").trim();
    const command = text.split(/\s+/u, 1)[0].split("@", 1)[0].toLowerCase();
    const current = localTime(this.now(), this.config.zone), today = current.date;
    if (["/start", "/help"].includes(command)) await this.telegram.send(chatId,
      `Привет! Я показываю расписание твоей группы с сайта ЧувГУ.\n\nНажми «Расписание на сегодня» или «Расписание на неделю». В «Подгруппа» можно оставить только свои пары.\n\nРассылка включается кнопкой и приходит в ${this.config.dailyTime} (${this.config.zone}).\nКоманды: /today, /tomorrow, /week, /days, /group, /subscribe, /unsubscribe.\nЛюбую ближайшую дату можно отправить как ДД.ММ.ГГГГ.`);
    else if (text === TODAY || command === "/today") await this.showDay(chatId, today);
    else if (text === WEEK || command === "/week") await this.showWeek(chatId, today);
    else if (text === TOMORROW || command === "/tomorrow") await this.showDay(chatId, addDays(today, 1));
    else if (text === PICK || command === "/days") {
      const buttons = Array.from({ length: 14 }, (_, index) => {
        const date = addDays(today, index);
        return { text: `${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"][weekday(date)]} ${displayDate(date).slice(0, 5)}`, callback_data: `day:${date}` };
      });
      await this.telegram.send(chatId, "Расписание на какой день?", { inline_keyboard: Array.from({ length: 7 }, (_, index) => buttons.slice(index * 2, index * 2 + 2)) });
    } else if (text === GROUP || command === "/group") await this.telegram.send(chatId, "Выбери свою подгруппу:", { inline_keyboard: [
      [{ text: "1-я подгруппа", callback_data: "group:1" }, { text: "2-я подгруппа", callback_data: "group:2" }], [{ text: "Все подгруппы", callback_data: "group:0" }],
    ] });
    else if (text === SUBSCRIBE || command === "/subscribe") {
      await this.store.subscribe(chatId, true, current.time < this.config.dailyTime ? today : addDays(today, 1));
      await this.telegram.send(chatId, `🔔 Рассылка включена: каждый день в ${this.config.dailyTime} (${this.config.zone}).\nПервое сообщение — в ближайшее такое время.`);
    } else if (text === STOP || command === "/unsubscribe") {
      await this.store.subscribe(chatId, false);
      await this.telegram.send(chatId, "🔕 Рассылка отключена. Расписание по кнопкам по-прежнему доступно.");
    } else if (/^\d{2}\.\d{2}\.\d{4}$/u.test(text)) {
      const [day, month, year] = text.split(".").map(Number);
      let target;
      try { target = isoDate(year, month, day); }
      catch { await this.telegram.send(chatId, "Такой даты нет. Отправь дату в формате ДД.ММ.ГГГГ."); return; }
      await this.showDay(chatId, target);
    } else await this.telegram.send(chatId, "Выбери кнопку внизу или отправь дату в формате ДД.ММ.ГГГГ.");
  }
  async callback(callback) {
    const message = callback.message, permitted = message?.chat?.type === "private" && this.authorized(callback.from?.id) && Number.isSafeInteger(message.chat.id);
    try { await this.telegram.call("answerCallbackQuery", { callback_query_id: callback.id, ...(permitted ? {} : { text: "Нет доступа." }) }); }
    catch (error) { if (!(error instanceof TelegramError) || error.code !== 400) throw error; } // An old callback can expire.
    if (!permitted) return;
    const chatId = message.chat.id, data = callback.data || "";
    if (/^group:[012]$/u.test(data)) {
      const subgroup = Number(data.at(-1));
      await this.store.subgroup(chatId, subgroup);
      await this.telegram.send(chatId, "Сохранено: " + (subgroup ? `${subgroup}-я подгруппа.` : "все подгруппы."));
    } else if (/^day:\d{4}-\d{2}-\d{2}$/u.test(data)) {
      const [year, month, day] = data.slice(4).split("-").map(Number);
      let target;
      try { target = isoDate(year, month, day); }
      catch { await this.telegram.send(chatId, "Выбери день заново через кнопку «Выбрать день»."); return; }
      await this.showDay(chatId, target);
    }
  }
  async daily() {
    const now = this.now(), current = localTime(now, this.config.zone);
    if (current.time < this.config.dailyTime) return;
    for (const candidate of await this.store.due(current.date, now, this.config.allowed)) {
      if (!this.authorized(candidate.chat_id)) continue;
      const token = crypto.randomUUID(), user = await this.store.claimDelivery(candidate.chat_id, current.date, now, token);
      if (!user) continue;
      try {
        const text = renderTimetable(await this.schedule.get(), current.date, user.subgroup);
        await this.telegram.send(user.chat_id, "🔔 Расписание на сегодня\n\n" + text);
        await this.store.finishDelivery(user.chat_id, current.date, token);
      } catch (error) {
        if (error instanceof TelegramError && error.code === 403) await this.store.subscribe(user.chat_id, false);
        await this.store.retryDelivery(user.chat_id, now + Math.max(300000, (error.retryAfter || 0) * 1000), token);
        console.warn(error instanceof ScheduleError ? "Schedule unavailable; delivery will retry" : `Delivery failed (${error instanceof TelegramError ? error.code : 0})`);
      }
    }
  }
}
