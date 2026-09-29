// Read-only live check without Telegram or a Cloudflare account.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { localTime } from "../src/bot.js";
import { renderTimetable } from "../src/schedule.js";
let mf;
try {
  const root = fileURLToPath(new URL("..", import.meta.url));
  mf = new Miniflare(convertV4MiniflareOptions({ rootPath: root, modulesRoot: root,
    modules: ["tests/worker.js", "src/index.js", "src/bot.js", "src/schedule.js"].map((path) => ({ type: "ESModule", path })),
    compatibilityDate: "2026-09-29", d1Databases: { DB: "live-check-db" }, bindings: { GROUP_ID: "8075", BOT_TIMEZONE: "Europe/Moscow" },
    // Local workerd lacks Windows' intermediate-certificate discovery. Use the
    // verified OS trust store for this diagnostic's network, keeping Worker parsing/D1.
    // The deployed Worker uses native fetch; production connectivity must be verified there.
    outboundService: async (request) => {
      if (new URL(request.url).origin !== "https://tt.chuvsu.ru") throw new Error("Unexpected check destination");
      const headers = new Headers(request.headers);
      // Node computes transport headers from the buffered request body.
      for (const name of ["Content-Length", "Transfer-Encoding", "Host"]) headers.delete(name);
      return fetch(request.url, { method: request.method, headers, redirect: "manual",
        body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(), signal: AbortSignal.timeout(15000) });
    },
  }));
  const db = await mf.getD1Database("DB"), schema = await readFile(new URL("../migrations/0001_state.sql", import.meta.url), "utf8");
  for (const sql of schema.split(";").map((part) => part.trim()).filter(Boolean)) await db.prepare(sql).run();
  const response = await mf.dispatchFetch("https://check.test/__test/site", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ now: Date.now() }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Сайт не ответил.");
  console.log(renderTimetable(data, localTime(Date.now()).date));
} catch (error) { console.error("Проверка не пройдена:", error.message); process.exitCode = 1; }
finally { await mf?.dispose(); }
