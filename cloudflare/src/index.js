import { Bot, Store, Telegram, TelegramError, configuration, localTime } from "./bot.js";
import { ScheduleClient } from "./schedule.js";

function services(env) {
  const config = configuration(env), store = new Store(env.DB);
  return { store, bot: new Bot(config, new Telegram(env.BOT_TOKEN), new ScheduleClient(env.DB, config.groupId), store) };
}
function ready(env) { return env.DB && /^\d+:[\w-]{20,}$/u.test(env.BOT_TOKEN || "") && /^[\w-]{32,256}$/u.test(env.WEBHOOK_SECRET || ""); }
async function secretMatches(actual, expected) {
  if (!actual || actual.length > 256) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([actual, expected].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  return crypto.subtle.timingSafeEqual(left, right);
}
async function boundedJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("No body");
  const decoder = new TextDecoder();
  let bytes = 0, text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 131072) { await reader.cancel(); throw new Error("Too large"); }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") {
      if (!ready(env)) return Response.json({ ok: false }, { status: 503 });
      try { configuration(env); await env.DB.prepare("SELECT chat_id FROM users LIMIT 0").all(); }
      catch { return Response.json({ ok: false }, { status: 503 }); }
      return Response.json({ ok: true });
    }
    if (path !== "/telegram") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("POST required", { status: 405, headers: { Allow: "POST" } });
    if (!ready(env)) return new Response("Not configured", { status: 503 });
    if (!await secretMatches(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), env.WEBHOOK_SECRET)) return new Response("Forbidden", { status: 403 });
    let update;
    try { update = await boundedJson(request); }
    catch { return new Response("Invalid update", { status: 400 }); }
    if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return new Response("Invalid update", { status: 400 });
    const token = crypto.randomUUID();
    let store, claimed = false;
    try {
      const app = services(env); store = app.store;
      const status = await store.claimUpdate(update.update_id, Date.now(), token);
      if (status === "done") return new Response("OK");
      if (status === "busy") return new Response("Retry", { status: 503, headers: { "Retry-After": "30" } });
      claimed = true;
      try { await app.bot.handle(update); }
      catch (error) {
        if (!(error instanceof TelegramError) || error.code !== 403) throw error;
        const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
        if (Number.isSafeInteger(chatId)) await store.subscribe(chatId, false);
      }
      await store.finishUpdate(update.update_id, token, true);
      return new Response("OK");
    } catch {
      if (claimed) try { await store.finishUpdate(update.update_id, token, false); } catch { /* Expiring lease allows a retry after storage recovers. */ }
      // Never log request bodies, chat IDs, secret headers, or token-bearing fetch errors.
      console.error("Webhook processing failed; Telegram may retry");
      return new Response("Retry", { status: 500 });
    }
  },
  async scheduled(controller, env) {
    if (!ready(env)) { console.error("Worker secrets or database missing"); return; }
    const { bot, store } = services(env);
    await bot.daily();
    // One small cleanup per day; stale updates are kept for seven days.
    const current = localTime(controller.scheduledTime, "UTC");
    if (current.time === "00:00") await store.cleanup(Date.now());
  },
};
