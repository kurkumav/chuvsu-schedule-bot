import { Telegram, TelegramError } from "../src/bot.js";
import { lookup } from "node:dns/promises";
import { setTimeout as pause } from "node:timers/promises";
import { settings, safeError, SetupError } from "./settings.mjs";
let step = "Чтение настроек";
try {
  const values = await settings(), telegram = new Telegram(values.BOT_TOKEN);
  const argument = process.argv[2];
  if (argument === "status") {
    const info = await telegram.call("getWebhookInfo");
    console.log(JSON.stringify({ url: info.url, pending_update_count: info.pending_update_count,
      last_error_date: info.last_error_date, has_error: Boolean(info.last_error_message) }, null, 2));
  } else if (argument === "disable") {
    await telegram.call("deleteWebhook", { drop_pending_updates: false });
    console.log("Webhook отключён. Можно запустить локальный Python-бот.");
  } else {
    if (!values.WEBHOOK_SECRET || !/^[\w-]{32,256}$/u.test(values.WEBHOOK_SECRET)) throw new Error("Нужен WEBHOOK_SECRET: сначала выполни npm run secrets.");
    let url;
    try { url = new URL(argument || values.WORKER_URL); } catch { throw new Error("Нужен HTTPS-адрес Worker: npm run webhook -- https://имя.поддомен.workers.dev"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("Нужен HTTPS-адрес Worker без пути и параметров.");
    // Do not switch Telegram until the production Worker and D1 are healthy.
    step = "Проверка Worker";
    let health;
    try { health = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(15000), redirect: "error" }); }
    catch { throw new Error("Worker health check failed"); }
    if (!health.ok || !(await health.json()).ok) throw new Error("Worker not ready");
    // Check HTTPS and the guest parser from Cloudflare before moving a working local bot.
    step = "Проверка расписания";
    const schedule = await fetch(new URL("/check", url), { method: "POST", redirect: "error", signal: AbortSignal.timeout(90000),
      headers: { "X-Telegram-Bot-Api-Secret-Token": values.WEBHOOK_SECRET } });
    if (!schedule.ok || !(await schedule.json()).ok) throw new SetupError("Worker опубликован, но не смог прочитать сайт ЧувГУ. Telegram ещё не переключён: проверь исходящий HTTPS в Cloudflare.");
    const webhook = { url: new URL("/telegram", url).href, secret_token: values.WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"], max_connections: 1, drop_pending_updates: false };
    // Resolve once before changing the webhook. A failed DNS-only setWebhook can
    // clear Telegram's previous URL, so don't first attempt a known failing path.
    if (url.hostname.endsWith(".workers.dev")) {
      const { address } = await lookup(url.hostname, { family: 4 });
      webhook.ip_address = address;
    }
    step = "Подключение Telegram";
    try { await telegram.call("setWebhook", webhook); }
    catch (error) {
      if (!(error instanceof TelegramError) || error.code !== 429) throw error;
      console.log(`Telegram просит подождать ${error.retryAfter} с перед настройкой webhook.`);
      await pause((error.retryAfter + 1) * 1000);
      await telegram.call("setWebhook", webhook);
    }
    step = "Настройка команд Telegram";
    await telegram.call("setMyCommands", { commands: [
      { command: "today", description: "Расписание на сегодня" }, { command: "tomorrow", description: "Расписание на завтра" },
      { command: "days", description: "Выбрать день" }, { command: "group", description: "Выбрать подгруппу" },
      { command: "subscribe", description: "Включить ежедневную рассылку" }, { command: "unsubscribe", description: "Отключить рассылку" },
    ] });
    step = "Проверка webhook";
    const info = await telegram.call("getWebhookInfo");
    if (info.url !== new URL("/telegram", url).href) throw new Error("Webhook verification failed");
    console.log(`Webhook подключён: ${info.url}\nОткрой бота в Telegram и нажми «Расписание на сегодня».`);
  }
} catch (error) { console.error(`${step}${error instanceof TelegramError ? `: Telegram ${error.code}` : ""}`); safeError(error); }
