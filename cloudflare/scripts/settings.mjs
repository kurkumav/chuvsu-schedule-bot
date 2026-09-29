import { readFile } from "node:fs/promises";
export async function settings() {
  // Environment wins; .dev.vars wins over the optional local Python .env.
  const values = {};
  for (const file of [new URL("../../.env", import.meta.url), new URL("../.dev.vars", import.meta.url)]) {
    let contents;
    try { contents = await readFile(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") continue; throw new Error("Не удалось прочитать локальные настройки."); }
    for (const line of contents.split(/\r?\n/u)) {
      const match = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/u.exec(line);
      if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/u, "$2");
    }
  }
  for (const name of ["BOT_TOKEN", "WEBHOOK_SECRET", "WORKER_URL"]) if (process.env[name]) values[name] = process.env[name];
  if (!/^\d+:[\w-]{20,}$/u.test(values.BOT_TOKEN || "")) throw new Error("Нужен BOT_TOKEN в .dev.vars, ../.env или переменной окружения.");
  return values;
}
export function safeError(error) { console.error(error.message?.startsWith("Нужен ") ? error.message : "Операция не выполнена. Проверь соединение, настройки и вход в Cloudflare."); process.exitCode = 1; }
