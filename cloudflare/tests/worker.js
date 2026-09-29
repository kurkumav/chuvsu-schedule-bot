// Test-only entry point; wrangler deploy uses src/index.js, never this file.
import worker from "../src/index.js";
import { Bot, Store, Telegram, configuration, chunks, localTime } from "../src/bot.js";
import { ScheduleClient, parseTimetable, renderTimetable, matchingLessons, weekFor, weekSet } from "../src/schedule.js";
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/__test/")) return worker.fetch(request, env, ctx);
    const data = await request.json();
    try {
      if (path === "/__test/parse") {
        const table = await parseTimetable(data.html, 8075);
        return Response.json({ table, queries: (data.queries || []).map(({ date, subgroup = 0 }) => ({
          week: weekFor(table, date), numbers: matchingLessons(table, date, subgroup).map((lesson) => lesson.number),
          text: renderTimetable(table, date, subgroup),
        })) });
      }
      if (path === "/__test/utilities") return Response.json({ weeks: weekSet(data.weeks), pieces: chunks(data.text), time: localTime(data.now) });
      const config = configuration(env), store = new Store(env.DB), now = () => data.now;
      if (data.allowed) config.allowed = new Set(data.allowed);
      const bot = new Bot(config, new Telegram(env.BOT_TOKEN), new ScheduleClient(env.DB, config.groupId, fetch, now, data.snapshotUrl), store, now);
      if (path === "/__test/handle") await bot.handle(data.update);
      else if (path === "/__test/daily") await Promise.all(Array.from({ length: data.concurrent || 1 }, () => bot.daily()));
      else if (path === "/__test/site") return Response.json(await bot.schedule.get());
      else return new Response("Unknown test", { status: 404 });
      return Response.json({ ok: true });
    } catch (error) { return Response.json({ error: error.message }, { status: 422 }); }
  },
  scheduled: worker.scheduled,
};
