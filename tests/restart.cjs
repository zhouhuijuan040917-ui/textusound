// Requires the synthetic backup emitted by `npm run test:browser`.
// Uses a disposable persistent profile and restarts the entire browser process.
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const { once } = require("node:events");
let context, server, profile;
(async () => {
  const backupPath =
    process.env.BACKUP_PATH ||
    path.join(
      process.env.TEST_ARTIFACT_DIR || "/tmp/toefl-studio-test",
      "synthetic-backup.json",
    );
  const backup = JSON.parse(fs.readFileSync(backupPath));
  const audio =
    backup.audio.find((a) => a.kind === "tts" && a.ownerType === "material") ||
    backup.audio.find((a) => a.kind === "original");
  assert.ok(
    audio,
    "The preceding browser suite must export a backup containing audio",
  );
  const root = path.resolve("dist");
  const types = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".wasm": "application/wasm",
  };
  server = http
    .createServer((req, res) => {
      const relative =
        new URL(req.url, "http://local").pathname.replace(/^\/+/, "") ||
        "index.html";
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      fs.readFile(file, (error, body) => {
        if (error) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          "Content-Type":
            types[path.extname(file)] || "application/octet-stream",
        });
        res.end(body);
      });
    })
    .listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/`;
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "toefl-restart-"));
  const executablePath =
    process.env.CHROME_PATH ||
    ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(fs.existsSync);
  const options = { executablePath, headless: true, args: ["--no-sandbox"] };
  context = await chromium.launchPersistentContext(profile, options);
  let page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(base + "#Settings");
  await page.locator("#backup-file").waitFor();
  await page.locator("#backup-file").setInputFiles(backupPath);
  await page.locator("[data-action=import]").click();
  await page.waitForFunction(() =>
    document.querySelector("#notice").textContent.includes("备份已恢复"),
  );
  await context.close();
  context = await chromium.launchPersistentContext(profile, options);
  page = await context.newPage();
  const external = [];
  page.on("request", (r) => {
    if (/huggingface|hf.co|jsdelivr/.test(r.url()))
      external.push(new URL(r.url()).hostname);
  });
  await page.goto(base + "#material/" + audio.ownerId);
  await page.locator(".audio-card").first().waitFor();
  const card = page.locator(`[data-audio-id="${audio.id}"]`);
  await card.locator("[data-action=replay]").click();
  await page.waitForTimeout(500);
  const result = await card
    .locator("audio")
    .evaluate((a) => ({
      duration: a.duration,
      currentTime: a.currentTime,
      paused: a.paused,
      error: a.error?.message || null,
    }));
  assert.ok(
    result.duration > 0 &&
      result.currentTime > 0 &&
      !result.paused &&
      !result.error,
  );
  assert.deepEqual(external, []);
  console.log(
    "PASS full browser restart retains materials and playable audio; zero model requests",
    JSON.stringify(result),
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await context?.close();
    server?.close();
    if (profile) fs.rmSync(profile, { recursive: true, force: true });
  });
