// Public timetable only: no Telegram token, user database or Cloudflare credentials.
import { request } from "node:https";
import { rootCertificates } from "node:tls";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
const origin = "https://tt.chuvsu.ru", groupId = 8075;
// The university omits this intermediate from its TLS handshake. Keep normal
// root/hostname/expiry verification, and supply the missing public certificate.
const ca = [...rootCertificates, await readFile(new URL("../certs/globalsign-r46-dv-2025.pem", import.meta.url), "utf8")];
const cookies = new Map();
async function get(url, method = "GET", body) {
  for (let redirects = 0; redirects < 5; redirects++) {
    if (new URL(url).origin !== origin) throw new Error("Unexpected timetable redirect");
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { result = await new Promise((resolve, reject) => {
      const headers = { "User-Agent": "ChuvsuScheduleBot/2.0", "Accept-Encoding": "identity" };
      if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      if (body) { headers["Content-Type"] = "application/x-www-form-urlencoded"; headers["Content-Length"] = Buffer.byteLength(body); }
      const req = request(url, { method, headers, ca, family: 4, signal: AbortSignal.timeout(15000) }, (res) => {
        const chunks = []; let size = 0;
        res.on("data", (chunk) => { size += chunk.length; if (size > 524288) res.destroy(new Error("Timetable page too large")); else chunks.push(chunk); });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject); req.end(body);
      }); break; }
      catch (error) {
        console.log(`Timetable ${method} ${new URL(url).pathname}: ${error.code || error.name}, attempt ${attempt + 1}`);
        if (attempt === 2) throw error;
        await pause((attempt + 1) * 2000);
      }
    }
    for (const cookie of result.headers["set-cookie"] || []) {
      const pair = cookie.split(";", 1)[0], equal = pair.indexOf("=");
      if (equal > 0) cookies.set(pair.slice(0, equal), pair.slice(equal + 1));
    }
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      if (!result.headers.location) throw new Error("Guest redirect without location");
      url = new URL(result.headers.location, url).href;
      if ([301, 302, 303].includes(result.status)) { method = "GET"; body = undefined; }
      continue;
    }
    if (result.status !== 200) throw new Error(`Timetable HTTP ${result.status}`);
    return result.text;
  }
  throw new Error("Too many guest redirects");
}
try {
  const source = `${origin}/index/grouptt/gr/${groupId}`;
  let html = await get(source);
  if (/<form\b[^>]*\bid=["']authtt["']/iu.test(html)) {
    await get(`${origin}/auth`, "POST", new URLSearchParams({ guest: "Войти гостем", wauto: "1", wname: "", wpass: "", pertt: "1" }).toString());
    html = await get(source);
  }
  if (!/\bid=["']groupstt["']/u.test(html) || /<form\b[^>]*\bid=["']authtt["']/iu.test(html)) throw new Error("No public timetable table");
  // Scripts and styles aren't needed by the parser or published in the snapshot.
  html = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "");
  const output = process.argv[2] || "snapshot-output/timetable.json";
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ version: 1, group_id: groupId, source_url: source, fetched_at: new Date().toISOString(), html }) + "\n");
  console.log("Public timetable snapshot saved; TLS and hostname verified");
} catch (error) {
  console.error("Snapshot refresh failed:", error.code || error.name);
  process.exitCode = 1;
}
