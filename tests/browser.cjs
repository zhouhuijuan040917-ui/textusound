/* Run against the production build under the real GitHub Pages subpath.
 * CHROME_PATH selects a local Chromium. RUN_TTS=1 performs real model downloads/inference.
 * No TTS mocks are used. The default suite tests storage/UI/backup without downloading a model.
 */
const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const prefix = "/textusound/";
const root = path.resolve("dist");
const results = [];
let browser, server;
const log = (name, details = "") => {
  results.push({ name, details });
  console.log("PASS", name, details);
};
const mime = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".png": "image/png",
};
(async () => {
  server = http
    .createServer((req, res) => {
      let requestPath;
      try {
        requestPath = decodeURIComponent(
          new URL(req.url, "http://test").pathname,
        );
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (!requestPath.startsWith(prefix)) {
        res.writeHead(404).end();
        return;
      }
      const file = path.resolve(
        root,
        requestPath.slice(prefix.length) || "index.html",
      );
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
            mime[path.extname(file)] || "application/octet-stream",
        });
        res.end(body);
      });
    })
    .listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}${prefix}`;
  const executablePath =
    process.env.CHROME_PATH ||
    ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(fs.existsSync);
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox"],
    ...(process.env.RUN_TTS && process.env.HTTPS_PROXY
      ? {
          proxy: {
            server: process.env.HTTPS_PROXY,
            bypass: "127.0.0.1,localhost",
          },
        }
      : {}),
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    timezoneId: "Asia/Shanghai",
  });
  // Some managed proxies intercept loopback despite Chrome's bypass list. This
  // route serves ONLY this test's loopback origin through Node's direct HTTP.
  await context.route(`${base}**`, async (route) => {
    const response = await new Promise((resolve, reject) =>
      http
        .get(route.request().url(), (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
        })
        .on("error", reject),
    );
    await route.fulfill(response);
  });
  let page = await context.newPage();
  const errors = [];
  const attach = (p) => {
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("requestfailed", (r) =>
      console.log(
        "REQUEST_FAILED",
        new URL(r.url()).hostname,
        new URL(r.url()).pathname,
        r.failure()?.errorText,
      ),
    );
    p.on("response", (r) => {
      if (r.status() >= 400)
        console.log(
          "HTTP_ERROR",
          r.status(),
          new URL(r.url()).hostname,
          new URL(r.url()).pathname,
        );
    });
    p.on("dialog", (d) => d.accept());
  };
  attach(page);
  const click = (action, within = page) =>
    within.locator(`[data-action="${action}"]`).first().click();
  const nav = async (view) => {
    await page
      .locator("nav")
      .getByRole("button", { name: view, exact: true })
      .click();
    await page.waitForTimeout(70);
  };
  const formFill = async (name, value) =>
    page.locator(`#editor [name="${name}"]`).fill(value);
  const save = async () => {
    await page.locator("#editor [type=submit]").click();
    await page.waitForFunction(() => !document.querySelector("#editor").open);
  };
  const getData = () =>
    page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open("toefl-learning-studio", 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction(
              ["materials", "vocabulary", "audio"],
              "readonly",
            );
            const names = ["materials", "vocabulary", "audio"];
            const req = names.map((n) => tx.objectStore(n).getAll());
            tx.oncomplete = () => {
              resolve(
                Object.fromEntries(
                  names.map((n, i) => [
                    n,
                    req[i].result.map((r) =>
                      n === "audio"
                        ? {
                            ...r,
                            blob: { size: r.blob.size, type: r.blob.type },
                          }
                        : r,
                    ),
                  ]),
                ),
              );
              db.close();
            };
          };
        }),
    );
  await page.goto(base);
  await page.getByRole("heading", { name: /A little practice/ }).waitFor();
  log("Production assets load beneath /textusound/");
  await nav("Speaking");
  await click("new-material");
  await formFill("title", "Education interview");
  await formFill("topic", "Education");
  assert.match(
    await page.locator("[name=date]").inputValue(),
    /^\d{4}-\d{2}-\d{2}$/,
  );
  for (let i = 0; i < 4; i++) {
    await formFill(
      `questions.${i}.text`,
      [
        "What do you study?",
        "Why learn English?",
        "Do you prefer teamwork?",
        "How do you learn?",
      ][i],
    );
    await formFill(
      `questions.${i}.answers.0.text`,
      [
        "I study biology.",
        "We exchange ideas.",
        "I like teamwork.",
        "I read every day.",
      ][i],
    );
  }
  await page.locator("[data-action=add-answer]").first().click();
  await formFill("questions.0.answers.1.text", "My own answer about learning.");
  await page
    .locator('[name="questions.0.answers.1.kind"]')
    .selectOption("My Answer");
  await page.locator("[name=status]").selectOption("Saved");
  await save();
  assert.equal(await page.locator(".question").count(), 4);
  let data = await getData();
  const speaking = data.materials[0];
  assert.equal(speaking.questions[0].answers.length, 2);
  log("Interview saved: four ordered questions and multiple answers");
  // Select real rendered text, including a highlighted term on subsequent edits.
  await page
    .locator(`[data-text-block="${speaking.questions[1].answers[0].id}"]`)
    .evaluate((el) => {
      const text = el.firstChild;
      const range = document.createRange();
      const index = text.textContent.indexOf("exchange ideas");
      range.setStart(text, index);
      range.setEnd(text, index + 14);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
  await page.waitForTimeout(80);
  await click("collect-selection");
  await formFill("meaning", "交流想法");
  await page.locator("[name=kind]").selectOption("Expressions");
  await save();
  assert.equal(await page.locator("mark").textContent(), "exchange ideas");
  data = await getData();
  assert.equal(data.vocabulary[0].sources[0].example, "We exchange ideas.");
  log(
    "Selection creates a highlighted expression with exact source and sentence",
  );
  await nav("Reading");
  await click("new-material");
  await formFill("title", "Learning together");
  await formFill("topic", "Education");
  await formFill(
    "body",
    "Students exchange ideas in a classroom. Flexibility helps them learn.",
  );
  await save();
  await click("new-vocab");
  await page.locator("[name=kind]").selectOption("Expressions");
  await formFill(
    "bulk",
    "exchange ideas - 交流想法\nplay a crucial role in - 在……中发挥重要作用",
  );
  await formFill("source-example", "Students exchange ideas in a classroom.");
  await save();
  data = await getData();
  assert.equal(
    data.vocabulary.find((v) => v.term === "exchange ideas").sources.length,
    2,
  );
  assert.equal(data.vocabulary.length, 2);
  log(
    "Cross-subject bulk vocabulary deduplicates and retains multiple sources",
  );
  await click("edit-material");
  await formFill("topic", "Society");
  await formFill("notes", "Reading notes");
  await save();
  data = await getData();
  assert.equal(
    data.vocabulary
      .find((v) => v.term === "exchange ideas")
      .sources.find((s) => s.section === "Reading").topic,
    "Society",
  );
  log("Topic edits update linked source metadata");
  await nav("Writing");
  for (const type of ["Email", "Academic Discussion"]) {
    await click("new-material");
    await formFill("title", `${type} practice`);
    await formFill("topic", "Education");
    await page.locator("[name=type]").selectOption(type);
    await formFill("prompt", "How can students learn together?");
    await formFill(
      "scenario",
      type === "Email" ? "Write to your teacher." : "",
    );
    await formFill(
      "studentResponses",
      type === "Academic Discussion" ? "Alex values teamwork." : "",
    );
    await formFill(
      "answers.0.text",
      "Students can exchange ideas and learn together.",
    );
    await save();
    await nav("Writing");
  }
  data = await getData();
  assert.equal(data.materials.filter((m) => m.section === "Writing").length, 2);
  log("Email and Academic Discussion materials saved");
  // Valid PCM WAV upload; not a generated speech mock.
  const buffer = Buffer.alloc(48044);
  buffer.write("RIFF");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24000, 24);
  buffer.writeUInt32LE(48000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(buffer.length - 44, 40);
  for (let i = 44; i < buffer.length; i += 2)
    buffer.writeInt16LE(
      Math.round(Math.sin((((i - 44) / 2) * 440 * 2 * Math.PI) / 24000) * 1000),
      i,
    );
  await nav("Listening");
  await click("new-material");
  await formFill("title", "Listening lecture");
  await formFill("topic", "Science");
  await formFill("body", "Today we discuss biology.");
  await page
    .locator("#original-file")
    .setInputFiles({ name: "lecture.wav", mimeType: "audio/wav", buffer });
  await save();
  await page.locator("audio").first().waitFor();
  assert.equal(
    await page
      .locator(".audio-meta")
      .textContent()
      .then((t) => t.includes("Original Audio")),
    true,
  );
  data = await getData();
  const listening = data.materials.find((m) => m.section === "Listening");
  assert.equal(data.audio[0].blob.size, buffer.length);
  await page.reload();
  await page.locator("audio").first().waitFor();
  await click("replay");
  await page.waitForTimeout(250);
  assert.equal(
    await page
      .locator("audio")
      .first()
      .evaluate((a) => a.currentTime > 0 && !a.error),
    true,
  );
  await page.locator("[data-loop]").check();
  await page.locator("[data-playback-speed]").selectOption("1.5");
  assert.equal(
    await page
      .locator("audio")
      .first()
      .evaluate((a) => a.loop && a.playbackRate === 1.5),
    true,
  );
  assert.ok(
    (await getData()).materials.find((m) => m.id === listening.id)
      .lastPracticedAt,
  );
  log(
    "Uploaded audio persists and plays after reload; loop and playback rate work",
  );
  const downloadOriginal = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download original" }).click();
  const originalDownload = await downloadOriginal;
  assert.equal(
    fs.readFileSync(await originalDownload.path()).length,
    buffer.length,
  );
  log("Uploaded original audio downloads intact");
  await nav("Vocabulary & Expressions");
  await page.locator("[data-action=tab][data-tab=Expressions]").click();
  await page.locator("[data-mastery]").first().selectOption("Learning");
  await nav("Review");
  await click("flip");
  assert.equal(await page.locator(".review-answer").count(), 1);
  await click("review-status");
  await page.locator("#review-mode").selectOption("Example → Expression");
  log("Review flip, mastery update and example recall work");
  await page.locator("#global-search").fill("biology");
  await page.waitForTimeout(350);
  assert.ok((await page.locator(".material-card").count()) >= 2);
  log("Global search includes body text across subjects");
  if (process.env.RUN_TTS) {
    await page.goto(`${base}#material/${speaking.id}`);
    await page.locator(".question").first().waitFor();
    // Test every interview question and first answer with the real shared worker.
    const targets = speaking.questions.flatMap((q) => [q.id, q.answers[0].id]);
    for (const blockId of targets) {
      await page
        .locator(`[data-action=generate-block][data-block="${blockId}"]`)
        .click();
      await page.waitForFunction(
        ({ id }) =>
          document.querySelector(`[id="block-${id}"] .audio-card`) ||
          document.querySelector("#notice.error:not([hidden])"),
        { id: blockId },
        { timeout: 240000 },
      );
      const card = page.locator(`[id="block-${blockId}"] .audio-card`);
      if (!(await card.count()))
        throw Error(await page.locator("#notice").textContent());
      assert.ok(
        await card.locator("audio").evaluate(async (a) => {
          if (!Number.isFinite(a.duration))
            await new Promise((resolve, reject) => {
              a.onloadedmetadata = resolve;
              a.onerror = reject;
            });
          return a.duration > 0;
        }),
      );
    }
    data = await getData();
    assert.equal(
      data.audio.filter((a) => a.kind === "tts").length,
      targets.length,
    );
    log(
      "REAL TTS: all four interview questions and four sample answers generated",
    );
    // Reopen in a different tab in the same browser profile: blobs must survive.
    await page.close();
    page = await context.newPage();
    attach(page);
    await page.goto(`${base}#material/${speaking.id}`);
    await page.locator(".audio-card").first().waitFor();
    await click("replay");
    await page.waitForTimeout(600);
    assert.equal(
      await page
        .locator("audio")
        .first()
        .evaluate((a) => a.currentTime > 0 && !a.paused && !a.error),
      true,
    );
    const before = (await getData()).audio.length;
    await page.locator("[data-action=generate-block]").first().click();
    await page.waitForTimeout(200);
    assert.equal((await getData()).audio.length, before);
    log(
      "Saved TTS reopens and plays in new tab; cache hit adds no duplicate audio",
    );
    const wavPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download WAV" }).first().click();
    const wav = await wavPromise;
    const bytes = fs.readFileSync(await wav.path());
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
    assert.equal(bytes.readUInt32LE(24), 24000);
    assert.ok(bytes.length > 44);
    log("REAL TTS: downloaded 24 kHz WAV validated", `${bytes.length} bytes`);
    await click("edit-material");
    await formFill("questions.0.text", "What subject do you like most?");
    await save();
    await page.locator(".stale .warning").first().waitFor();
    log("Changed text marks existing audio as an old version");
    await nav("Vocabulary & Expressions");
    await page.locator("[data-tab=Expressions]").click();
    const vocab = (await getData()).vocabulary.find(
      (v) => v.term === "exchange ideas",
    );
    await page
      .locator(`[data-action=vocab-audio][data-id="${vocab.id}"]`)
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".vocab-card .audio-card") ||
        document.querySelector("#notice.error:not([hidden])"),
      {},
      { timeout: 240000 },
    );
    assert.equal(
      (await getData()).audio.some(
        (a) => a.ownerType === "vocabulary" && a.ownerId === vocab.id,
      ),
      true,
    );
    log("REAL TTS: independent expression pronunciation persisted");
    await click("new-vocab");
    await formFill("term", "opportunity");
    await formFill("meaning", "机会");
    await page.locator("[name=kind]").selectOption("Vocabulary");
    await save();
    await page.locator("[data-tab=Vocabulary]").click();
    const word = (await getData()).vocabulary.find(
      (v) => v.term === "opportunity",
    );
    await page
      .locator(`[data-action=vocab-audio][data-id="${word.id}"]`)
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".vocab-card .audio-card") ||
        document.querySelector("#notice.error:not([hidden])"),
      {},
      { timeout: 240000 },
    );
    assert.equal(
      (await getData()).audio.some(
        (a) => a.ownerType === "vocabulary" && a.ownerId === word.id,
      ),
      true,
    );
    log("REAL TTS: independent single-word pronunciation persisted");
    await page.locator("#voice").selectOption("bf_emma");
    await page.locator("#generation-speed").selectOption("0.8");
    await page
      .locator(`[data-action=vocab-audio][data-id="${word.id}"]`)
      .click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".vocab-card .audio-card").length === 2 ||
        document.querySelector("#notice.error:not([hidden])"),
      {},
      { timeout: 240000 },
    );
    const versions = (await getData()).audio.filter(
      (a) => a.ownerId === word.id,
    );
    assert.equal(versions.length, 2);
    assert.ok(versions.some((a) => a.voice === "bf_emma" && a.speed === 0.8));
    log("REAL TTS: British voice at 0.8× saves a separate word audio version");
    for (const material of (await getData()).materials.filter(
      (m) => m.section === "Writing",
    )) {
      await page.goto(`${base}#material/${material.id}`);
      await page
        .locator(
          `[data-action=generate-block][data-block="${material.answers[0].id}"]`,
        )
        .waitFor();
      await page
        .locator(
          `[data-action=generate-block][data-block="${material.answers[0].id}"]`,
        )
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector(".audio-card") ||
          document.querySelector("#notice.error:not([hidden])"),
        {},
        { timeout: 240000 },
      );
      assert.ok(
        (await getData()).audio.some(
          (a) => a.ownerId === material.id && a.kind === "tts",
        ),
      );
    }
    log("REAL TTS: Email and Academic Discussion sample answers generated");
    const readingMaterial = (await getData()).materials.find(
      (m) => m.section === "Reading",
    );
    await page.goto(`${base}#material/${readingMaterial.id}`);
    await page.locator(".sentences summary").click();
    await click("sentence-audio");
    await page.waitForFunction(
      () =>
        document.querySelector(".audio-card") ||
        document.querySelector("#notice.error:not([hidden])"),
      {},
      { timeout: 240000 },
    );
    assert.ok(
      (await getData()).audio.some(
        (a) => a.ownerId === readingMaterial.id && a.scope === "excerpt",
      ),
    );
    log("REAL TTS: Reading sentence practice persists excerpt audio");
    await page.goto(`${base}#material/${listening.id}`);
    await page.locator("[data-action=generate-block]").waitFor();
    await click("generate-block");
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".audio-card").length === 2 ||
        document.querySelector("#notice.error:not([hidden])"),
      {},
      { timeout: 240000 },
    );
    const listeningAudio = (await getData()).audio.filter(
      (a) => a.ownerId === listening.id,
    );
    assert.ok(
      listeningAudio.some((a) => a.kind === "original") &&
        listeningAudio.some((a) => a.kind === "tts"),
    );
    log(
      "REAL TTS: Listening transcript synthesis coexists with original audio",
    );
  } else console.log("UNRUN real model/inference checks; set RUN_TTS=1 to run");
  await nav("Settings");
  const exportEvent = page.waitForEvent("download");
  await click("export");
  const backupDownload = await exportEvent;
  const backupBuffer = fs.readFileSync(await backupDownload.path());
  const backup = JSON.parse(backupBuffer);
  assert.ok(
    backup.audio.length > 0 && backup.audio.every((a) => a.data && !a.blob),
  );
  const artifactDir = process.env.TEST_ARTIFACT_DIR || "/tmp/toefl-studio-test";
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, "synthetic-backup.json"),
    backupBuffer,
  );
  const prior = await getData();
  await page.locator("#backup-file").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        ...backup,
        vocabulary: [
          { ...backup.vocabulary[0], sources: [{ materialId: "missing" }] },
        ],
      }),
    ),
  });
  await click("import");
  await page.waitForTimeout(200);
  assert.equal((await getData()).materials.length, prior.materials.length);
  assert.match(await page.locator("#notice").textContent(), /格式或关联无效/);
  log("Malformed backup rejected without modifying stored data");
  // Remove a material, confirm global vocabulary survives, then restore every record/audio.
  const reading = prior.materials.find((m) => m.section === "Reading");
  await page.goto(`${base}#material/${reading.id}`);
  await page.locator("[data-action=delete-material]").waitFor();
  await click("delete-material");
  await page.waitForTimeout(150);
  const afterDeletion = await getData();
  assert.equal(afterDeletion.materials.length, prior.materials.length - 1);
  assert.equal(afterDeletion.vocabulary.length, prior.vocabulary.length);
  assert.ok(
    afterDeletion.vocabulary.every((v) =>
      v.sources.every((s) => s.materialId !== reading.id),
    ),
  );
  log("Deleting material unlinks sources and preserves global vocabulary");
  await nav("Settings");
  await page.locator("#backup-file").setInputFiles({
    name: "restore.json",
    mimeType: "application/json",
    buffer: backupBuffer,
  });
  await click("import");
  await page.waitForFunction(() =>
    document.querySelector("#notice").textContent.includes("备份已恢复"),
  );
  const restored = await getData();
  assert.deepEqual(
    restored.materials.map((m) => m.id).sort(),
    prior.materials.map((m) => m.id).sort(),
  );
  assert.deepEqual(restored.vocabulary, prior.vocabulary);
  assert.deepEqual(
    restored.audio.map((a) => [a.id, a.blob.size, a.ownerId]).sort(),
    prior.audio.map((a) => [a.id, a.blob.size, a.ownerId]).sort(),
  );
  await page.goto(`${base}#material/${listening.id}`);
  await page.locator("audio").first().waitFor();
  await click("replay");
  await page.waitForTimeout(300);
  assert.ok(
    await page
      .locator("audio")
      .first()
      .evaluate((a) => a.currentTime > 0 && !a.error),
  );
  log(
    "Full backup restores materials, sources, mastery and playable audio bytes",
  );
  if (process.env.RUN_TTS) {
    await page.goto(`${base}#material/${speaking.id}`);
    await page.locator(".audio-card").first().waitFor();
    await click("replay");
    await page.waitForTimeout(400);
    assert.ok(
      await page
        .locator("audio")
        .first()
        .evaluate((a) => a.currentTime > 0 && !a.error),
    );
    log("Restored generated speech decodes and plays without regeneration");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const output = process.env.TEST_ARTIFACT_DIR || "/tmp/toefl-studio-test";
  fs.mkdirSync(output, { recursive: true });
  await page.screenshot({
    path: path.join(output, "mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await nav("Dashboard");
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelector("#notice").hidden = true;
    document.activeElement?.blur();
  });
  await page.screenshot({
    path: path.join(output, "dashboard.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  log(
    "Responsive mobile layout has no horizontal overflow; no page script errors",
  );
  fs.writeFileSync(
    path.join(output, "results.json"),
    JSON.stringify({ realTTS: Boolean(process.env.RUN_TTS), results }, null, 2),
  );
  console.log(
    `Completed ${results.length} browser checks. Artifacts: ${output}`,
  );
})()
  .catch(async (e) => {
    console.error(e);
    process.exitCode = 1;
    const p = browser?.contexts()[0]?.pages().at(-1);
    if (p) {
      await p.screenshot({
        path: "/tmp/toefl-studio-failure.png",
        fullPage: true,
      });
      fs.writeFileSync("/tmp/toefl-studio-failure.html", await p.content());
    }
  })
  .finally(async () => {
    await browser?.close();
    server?.close();
  });
