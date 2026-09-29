import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { settings, safeError } from "./settings.mjs";
try {
  const values = await settings();
  if (!values.WEBHOOK_SECRET || values.WEBHOOK_SECRET === "random_secret_at_least_32_characters") {
    values.WEBHOOK_SECRET = randomBytes(32).toString("hex");
    const file = new URL("../.dev.vars", import.meta.url);
    let existing = "";
    try { existing = await readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    existing = existing.replace(/^\s*WEBHOOK_SECRET\s*=.*$/gmu, "");
    if (!/^BOT_TOKEN=/mu.test(existing)) existing += `\nBOT_TOKEN=${values.BOT_TOKEN}\n`;
    await writeFile(file, `${existing.trim()}\nWEBHOOK_SECRET=${values.WEBHOOK_SECRET}\n`, { mode: 0o600 });
  }
  if (!/^[\w-]{32,256}$/u.test(values.WEBHOOK_SECRET)) throw new Error("Нужен WEBHOOK_SECRET из 32–256 букв, цифр, _ или -.");
  const executable = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
  const child = spawn(process.execPath, [executable, "secret", "bulk"], { cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  child.stdin.end(JSON.stringify({ BOT_TOKEN: values.BOT_TOKEN, WEBHOOK_SECRET: values.WEBHOOK_SECRET }));
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  output = output.replaceAll(values.BOT_TOKEN, "[TOKEN]").replaceAll(values.WEBHOOK_SECRET, "[SECRET]");
  process.stdout.write(output);
  if (code !== 0) throw new Error("Secret upload failed");
  console.log("Секреты сохранены в Cloudflare. Значения не публикуются.");
} catch (error) { safeError(error); }
