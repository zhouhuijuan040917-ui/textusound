import "./studio.css";
import {
  SECTIONS,
  STATUSES,
  uid,
  today,
  all,
  put,
  remove,
  mutate,
  blocks,
  newMaterial,
  sourceFor,
  mergeVocabulary,
  parseVocabulary,
  textHash,
  exportBackup,
  importBackup,
} from "./studio-db.js";
import { VOICE_GROUPS, DEFAULT_VOICE } from "./voices.js";
import { generate, cancelGeneration, onTtsProgress } from "./studio-tts.js";
import {
  primeMru,
  supportsFsAccess,
  pickSaveFile,
  writeToHandle,
  downloadBlob,
} from "./save.js";

const app = document.querySelector("#app");
const dialog = document.querySelector("#editor");
const notice = document.querySelector("#notice");
const h = (value = "") =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const safeName = (s) =>
  s.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, "-").slice(0, 70) || "audio";
const state = {
  materials: [],
  vocabulary: [],
  audio: [],
  view: "Dashboard",
  materialId: null,
  search: "",
  topic: "",
  date: "",
  status: "",
  type: "",
  section: "",
  tab: "Vocabulary",
  voice: DEFAULT_VOICE,
  speed: 1,
  busy: false,
  reviewIndex: 0,
  flipped: false,
  mode: "English → 中文",
  selection: null,
};
let editorRecord,
  editorType,
  editorSource,
  dirty = false,
  sourceFile = null;
let urls = [];
let flashTimer;
const newUrl = (blob) => {
  const url = URL.createObjectURL(blob);
  urls.push(url);
  return url;
};
const currentMaterial = () =>
  state.materials.find((m) => m.id === state.materialId);
const currentBlock = (id) => blocks(currentMaterial()).find((b) => b.id === id);
const action = (name, label, attrs = "", cls = "") =>
  `<button type="button" data-action="${name}" class="${cls}" ${attrs}>${label}</button>`;
const empty = (text) =>
  `<div class="empty"><span class="empty-symbol" aria-hidden="true">◇</span><p>${text}</p></div>`;
const field = (label, name, value = "", type = "text", extra = "") =>
  `<label>${label}<input name="${name}" type="${type}" value="${h(value)}" ${extra}></label>`;
const area = (label, name, value = "", extra = "") =>
  `<label>${label}<textarea name="${name}" rows="5" ${extra}>${h(value)}</textarea></label>`;
const options = (items, selected) =>
  items
    .map(
      (item) =>
        `<option ${item === selected ? "selected" : ""}>${h(item)}</option>`,
    )
    .join("");
const select = (label, name, items, selected) =>
  `<label>${label}<select name="${name}">${options(items, selected)}</select></label>`;
function flash(message, error = false) {
  clearTimeout(flashTimer);
  notice.textContent = message;
  notice.className = error ? "toast error" : "toast";
  notice.hidden = false;
  flashTimer = setTimeout(
    () => {
      notice.hidden = true;
    },
    error ? 20000 : 6500,
  );
}
async function reloadData() {
  [state.materials, state.vocabulary, state.audio] = await Promise.all([
    all("materials"),
    all("vocabulary"),
    all("audio"),
  ]);
  state.materials.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  state.vocabulary.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}
function navigate(view, materialId = null) {
  state.view = view;
  state.materialId = materialId;
  state.topic = state.date = state.status = state.type = state.section = "";
  state.search = "";
  state.reviewIndex = 0;
  state.flipped = false;
  state.selection = null;
  const hash = materialId
    ? `#material/${encodeURIComponent(materialId)}`
    : `#${encodeURIComponent(view)}`;
  if (location.hash !== hash) location.hash = hash;
  else {
    render();
    window.scrollTo(0, 0);
  }
}
function readRoute() {
  const hash = location.hash.slice(1);
  if (hash.startsWith("material/")) {
    try {
      state.materialId = decodeURIComponent(hash.slice(9));
    } catch {
      state.materialId = null;
    }
    state.view = currentMaterial()?.section || "Dashboard";
  } else {
    let requested;
    try {
      requested = decodeURIComponent(hash);
    } catch {
      requested = "Dashboard";
    }
    state.view = [
      "Dashboard",
      ...SECTIONS,
      "Vocabulary & Expressions",
      "Review",
      "Settings",
    ].includes(requested)
      ? requested
      : "Dashboard";
    state.materialId = null;
  }
  render();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", readRoute);
const matches = (text) =>
  !state.search ||
  String(text).toLocaleLowerCase().includes(state.search.toLocaleLowerCase());
function materialMatches(m) {
  return (
    (!state.topic || m.topic === state.topic) &&
    (!state.date || m.date === state.date) &&
    (!state.status || m.status === state.status) &&
    (!state.type || m.type === state.type) &&
    matches(
      [
        m.title,
        m.topic,
        m.notes,
        m.source,
        m.scenario,
        m.studentResponses,
        ...blocks(m).map((b) => b.text),
      ].join(" "),
    )
  );
}
function vocabMatches(v) {
  const sources = v.sources.map((s) => ({
    ...s,
    ...(state.materials.find((m) => m.id === s.materialId) || {}),
  }));
  return (
    (!state.topic || sources.some((s) => s.topic === state.topic)) &&
    (!state.date || v.addedAt === state.date) &&
    (!state.status || v.status === state.status) &&
    (!state.section || sources.some((s) => s.section === state.section)) &&
    matches(
      [
        v.term,
        v.meaning,
        v.notes,
        ...sources.map((s) => `${s.example} ${s.topic} ${s.title}`),
      ].join(" "),
    )
  );
}
function filters(vocab = false) {
  const topics = [
    ...new Set(state.materials.map((m) => m.topic).filter(Boolean)),
  ].sort();
  return `<div class="filters"><label>Topic<select data-filter="topic"><option value="">All topics</option>${options(topics, state.topic)}</select></label><label>${vocab ? "Date added" : "Date"}<input type="date" data-filter="date" value="${h(state.date)}"></label><label>Status<select data-filter="status"><option value="">All statuses</option>${options(vocab ? STATUSES : ["Draft", "Saved"], state.status)}</select></label>${vocab ? `<label>Section<select data-filter="section"><option value="">All sections</option>${options(SECTIONS, state.section)}</select></label>` : state.view === "Writing" ? `<label>Writing type<select data-filter="type"><option value="">All types</option>${options(["Email", "Academic Discussion"], state.type)}</select></label>` : ""}${action("clear-filters", "Reset", "", "subtle")}</div>`;
}
function materialCard(m) {
  return `<button type="button" class="material-card" data-action="open-material" data-id="${h(m.id)}"><span class="eyebrow">${h(m.section)} · ${h(m.type || (m.section === "Speaking" ? "Interview" : "Library"))}</span><h3>${h(m.title)}</h3><p>${h(m.topic || "Uncategorized")}</p><div class="card-bottom"><time>${h(m.date)}</time><span class="badge ${m.status === "Draft" ? "draft" : ""}">${h(m.status)}</span></div></button>`;
}
function dashboard() {
  const materials = state.materials.filter(materialMatches);
  const vocabulary = state.vocabulary.filter(vocabMatches);
  return `<div class="hero"><div><span class="eyebrow">YOUR PERSONAL ENGLISH WORKSPACE</span><h1>A little practice.<br>A lasting collection.</h1><p>保存今天的练习，积累明天的表达。</p><div class="toolbar">${action("new-material", "+ New Material", 'data-section="Reading"', "primary")}${action("new-material", "New Interview Session", 'data-section="Speaking"')}</div></div><div class="hero-art" aria-hidden="true"><div class="book"><span>TOEFL<br>LEARNING<br><b>STUDIO</b></span></div><span class="art-note">Read. Listen.<br>Write. Speak.</span></div></div><div class="stats">${SECTIONS.map((s, i) => `<button data-action="navigate" data-view="${s}" class="stat"><span class="stat-icon">${["R", "L", "W", "S"][i]}</span><strong>${state.materials.filter((m) => m.section === s).length}</strong><span>${s} materials</span></button>`).join("")}<div class="stat"><span class="stat-icon">Aa</span><strong>${state.vocabulary.length}</strong><span>Words & expressions</span></div></div><div class="dashboard-grid"><section><div class="section-heading"><h2>${state.search ? "Search results" : "Recent materials"}</h2><span>${materials.length} matches</span></div><div class="card-grid">${
    materials
      .slice(0, state.search ? undefined : 6)
      .map(materialCard)
      .join("") || empty("还没有材料。点击 New Material，开始建立你的资料库。")
  }</div><h2>Recent interviews</h2><div class="card-grid">${
    materials
      .filter((m) => m.section === "Speaking")
      .sort((a, b) =>
        (b.lastPracticedAt || b.updatedAt).localeCompare(
          a.lastPracticedAt || a.updatedAt,
        ),
      )
      .slice(0, 3)
      .map(materialCard)
      .join("") || empty("创建一组包含四道题的 Interview Session。")
  }</div></section><aside><div class="panel"><h2>Your vocabulary</h2><div class="mastery-summary">${STATUSES.map((s) => `<div><strong>${state.vocabulary.filter((v) => v.status === s).length}</strong><span>${s}</span></div>`).join("")}</div>${action("navigate", "Start a review →", 'data-view="Review"', "primary full")}</div><div class="panel"><h2>Recently collected</h2>${
    vocabulary
      .slice(0, state.search ? undefined : 6)
      .map(
        (v) =>
          `<div class="compact-word"><strong>${h(v.term)}</strong><span>${h(v.meaning || "尚未添加释义")}</span>${action("vocab-audio", "Listen", `data-id="${h(v.id)}"`, "subtle")}</div>`,
      )
      .join("") || "<p class=muted>选中正文中的词句，添加中文释义与来源。</p>"
  }</div></aside></div>`;
}
function library() {
  const list = state.materials.filter(
    (m) => m.section === state.view && materialMatches(m),
  );
  const groups = Map.groupBy
    ? Map.groupBy(list, (m) => m.topic || "Uncategorized")
    : list.reduce((map, m) => {
        const key = m.topic || "Uncategorized";
        map.set(key, [...(map.get(key) || []), m]);
        return map;
      }, new Map());
  return `<div class="page-heading"><div><span class="eyebrow">YOUR ${h(state.view).toUpperCase()} LIBRARY</span><h1>${h(state.view)}</h1><p>${{ Speaking: "每次四道题，一起保存题目、回答和积累的表达。", Writing: "Write an Email · Write for an Academic Discussion", Reading: "收藏文章，选词积累，逐句精读。", Listening: "原始录音与 TTS 分开保存，让原文和声音始终在一起。" }[state.view]}</p></div>${action("new-material", state.view === "Speaking" ? "+ New Interview Session" : "+ New Material", `data-section="${state.view}"`, "primary")}</div>${filters()}${[...groups].map(([topic, records]) => `<section><div class="section-heading"><h2>${h(topic)}</h2><span>${records.length} materials</span></div><div class="card-grid">${records.map(materialCard).join("")}</div></section>`).join("") || empty("没有匹配的材料。新建一条，或调整搜索和筛选条件。")}`;
}
function highlighted(text, blockId) {
  const terms = state.vocabulary
    .filter((v) =>
      v.sources.some(
        (s) => s.materialId === state.materialId && s.blockId === blockId,
      ),
    )
    .map((v) => v.term)
    .sort((a, b) => b.length - a.length);
  if (!terms.length) return h(text);
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(terms.map(escapeRegex).join("|"), "gi");
  let result = "",
    last = 0;
  for (const match of text.matchAll(regex)) {
    result += h(text.slice(last, match.index)) + `<mark>${h(match[0])}</mark>`;
    last = match.index + match[0].length;
  }
  return result + h(text.slice(last));
}
function sentences(text) {
  return typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)]
        .map((s) => s.segment.trim())
        .filter(Boolean)
    : text.match(/[^.!?]+[.!?]*/g) || [];
}
function voiceControls() {
  return `<label>Voice<select id="voice">${VOICE_GROUPS.map((group) => `<optgroup label="${h(group.label)}">${group.voices.map((v) => `<option value="${v.id}" ${v.id === state.voice ? "selected" : ""}>${h(v.name)}</option>`).join("")}</optgroup>`).join("")}</select></label><label>Generation rate<select id="generation-speed">${[0.5, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.5, 2].map((n) => `<option value="${n}" ${n === state.speed ? "selected" : ""}>${n}×</option>`).join("")}</select></label>`;
}
function audioCard(a, sourceText) {
  const stale = a.kind === "tts" && (a.sourceText ?? a.text) !== sourceText;
  const url = newUrl(a.blob);
  return `<div class="audio-card ${stale ? "stale" : ""}" data-audio-id="${h(a.id)}"><div class="audio-meta"><span>${a.kind === "original" ? "Original Audio · 用户上传" : `Generated TTS · ${h(a.voice)} · ${a.speed}×${a.scope === "excerpt" ? " · Selected sentence" : ""}`}</span><span>${h(a.createdAt.slice(0, 10))}</span></div>${stale ? '<p class="warning">文字已修改：此音频对应旧版本。可以保留旧音频，或生成新版本。</p>' : ""}${a.scope === "excerpt" ? `<p class="excerpt">${h(a.text)}</p>` : ""}<audio controls preload="metadata" src="${url}"></audio><div class="audio-tools">${action("replay", "Replay", "", "subtle")}<label class="inline"><input type="checkbox" data-loop> Loop</label><label class="inline">Playback <select data-playback-speed>${[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => `<option ${s === 1 ? "selected" : ""}>${s}</option>`).join("")}</select>×</label><a class="button subtle" href="${url}" download="${h(a.filename)}">Download ${a.kind === "tts" ? "WAV" : "original"}</a>${action("save-audio", "Save as…", `data-id="${h(a.id)}"`, "subtle")}${action("delete-audio", "Delete", `data-id="${h(a.id)}"`, "subtle danger")}</div></div>`;
}
function textBlock(block) {
  const audio = state.audio.filter(
    (a) =>
      a.ownerType === "material" &&
      a.ownerId === state.materialId &&
      a.blockId === block.id &&
      a.kind === "tts",
  );
  const sentenceList = sentences(block.text);
  return `<section class="text-block" id="block-${h(block.id)}"><div class="section-heading"><h3>${h(block.label)}</h3>${block.text.trim() ? action("generate-block", "▶ Generate / Play", `data-block="${h(block.id)}"`, "small") : ""}</div><div class="prose" data-text-block="${h(block.id)}">${block.text ? highlighted(block.text, block.id) : '<span class="muted">尚未填写。点击 Edit 添加内容。</span>'}</div>${block.text ? `<details class="sentences"><summary>Sentence practice · ${sentenceList.length} sentences</summary>${sentenceList.map((s, i) => `<div><span>${h(s)}</span>${action("sentence-audio", "▶", `data-block="${h(block.id)}" data-index="${i}" aria-label="Read sentence ${i + 1}"`, "subtle")}</div>`).join("")}</details>` : ""}${audio.map((a) => audioCard(a, block.text)).join("")}</section>`;
}
function materialPage(m) {
  const linked = state.vocabulary.filter((v) =>
    v.sources.some((s) => s.materialId === m.id),
  );
  const original = state.audio.filter(
    (a) =>
      a.ownerType === "material" && a.ownerId === m.id && a.kind === "original",
  );
  const blockList = blocks(m);
  let main;
  if (m.section === "Speaking") {
    main = m.questions
      .map(
        (q, i) =>
          `<details class="question" open><summary><span class="question-number">${i + 1}</span><strong>Question ${i + 1}</strong><span>${h(q.text.slice(0, 70) || "Draft question")}</span></summary><div class="question-body">${textBlock(blockList.find((b) => b.id === q.id))}${q.answers.map((a) => textBlock(blockList.find((b) => b.id === a.id))).join("")}</div></details>`,
      )
      .join("");
  } else
    main = `${m.scenario ? `<div class="panel"><h3>Scenario</h3><p class="prose">${h(m.scenario)}</p></div>` : ""}${m.studentResponses ? `<div class="panel"><h3>Student Responses</h3><p class="prose">${h(m.studentResponses)}</p></div>` : ""}${m.section === "Listening" ? `<div class="panel"><div class="section-heading"><h2>Original Audio</h2>${action("upload-original", "+ Upload audio", "", "small")}</div><p class="muted">用户提供的原始录音。下方 Generated TTS 是合成朗读，不是真实 TOEFL 原始录音。</p>${original.map((a) => audioCard(a, "")).join("") || '<p class="muted">尚未上传 MP3、WAV、M4A、OGG 等音频。</p>'}</div>` : ""}${blockList.map(textBlock).join("")}`;
  return `<div class="page-heading"><div><button class="back-link" data-action="back-library">← ${h(m.section)} library</button><div class="eyebrow">${h(m.section)} ${m.type ? ` / ${h(m.type)}` : ""} · ${h(m.status)}</div><h1>${h(m.title)}</h1><p>${h(m.topic || "Uncategorized")} <span class="dot">·</span> ${h(m.date)}</p></div><div class="toolbar">${action("edit-material", "Edit", `data-id="${h(m.id)}"`)}${action("delete-material", "Delete", `data-id="${h(m.id)}"`, "danger subtle")}</div></div><div class="study-grid"><article>${main}${m.notes ? `<div class="panel"><h3>Study notes</h3><p class="prose">${h(m.notes)}</p></div>` : ""}${m.source ? `<p class="muted">Source: ${h(m.source)}</p>` : ""}</article><aside class="study-aside"><div class="panel"><span class="eyebrow">SHARED KOKORO ENGINE</span><h2>Listen & shadow</h2><p class="muted">英美声线 · 浏览器本地生成 · 保存后直接播放</p><div class="voice-controls">${voiceControls()}</div><p class="small-text">首次需下载模型，可能较慢。音频会自动保存到当前材料。</p></div><div class="panel selection-panel"><h2>Collect an expression</h2><p>在正文中选中英文词、短语或句子，再点击下方按钮。</p><p id="selection-preview" class="selection-preview">No text selected</p>${action("collect-selection", "+ Add selected text", "", "primary full")}${action("read-selection", "▶ Read selected text", "", "full subtle")}</div><div class="panel"><div class="section-heading"><h2>Vocabulary Bank</h2><span>${linked.length}</span></div>${action("new-vocab", "+ Add / bulk import", `data-material="${h(m.id)}"`, "full")}${linked.map((v) => `<div class="compact-word"><button class="text-button" data-action="edit-vocab" data-id="${h(v.id)}">${h(v.term)}</button><span>${h(v.meaning)}</span>${action("vocab-audio", "▶ Pronounce", `data-id="${h(v.id)}"`, "subtle")}</div>`).join("")}${action("navigate", "Open global vocabulary →", 'data-view="Vocabulary &amp; Expressions"', "subtle full")}</div></aside></div>`;
}
function sourceLinks(v) {
  return v.sources.length
    ? v.sources
        .map((s) => {
          const m = state.materials.find((m) => m.id === s.materialId);
          return `<div class="source-item">${action("source", `${h(m?.section || s.section)} · ${h(m?.topic || s.topic)} · ${h(m?.title || s.title)} · ${h(m ? blocks(m).find((b) => b.id === s.blockId)?.label || "" : "")} · ${h(m?.date || s.date)}`, `data-id="${h(s.materialId)}" data-block="${h(s.blockId)}"`, "source-link")}<p class="prose">${h(s.example || "未填写例句")}</p></div>`;
        })
        .join("")
    : '<p class="muted">独立词条，没有关联材料。</p>';
}
function vocabularyPage() {
  const list = state.vocabulary.filter(
    (v) => v.kind === state.tab && vocabMatches(v),
  );
  return `<div class="page-heading"><div><span class="eyebrow">ONE COLLECTION, EVERY SUBJECT</span><h1>Vocabulary & Expressions</h1><p>每次收录都保留来源；同一个词可以有多个例句。</p></div>${action("new-vocab", "+ Add vocabulary", "", "primary")}</div><div class="tabs">${["Vocabulary", "Expressions"].map((tab) => action("tab", tab, `data-tab="${tab}" aria-pressed="${state.tab === tab}"`, state.tab === tab ? "active" : "")).join("")}</div>${filters(true)}<div class="inline-voice">${voiceControls()}</div><div class="vocabulary-list">${
    list
      .map(
        (v) =>
          `<article class="panel vocab-card" data-vocab-id="${h(v.id)}"><div class="section-heading"><div><h2>${h(v.term)}</h2><p>${h(v.pos)} ${h(v.ipa)}</p></div><span class="badge">${h(v.status)}</span></div><p class="meaning">${h(v.meaning || "尚未填写中文释义")}</p>${v.translation ? `<p>例句翻译：${h(v.translation)}</p>` : ""}${v.notes ? `<p class="prose">${h(v.notes)}</p>` : ""}<div class="toolbar">${action("vocab-audio", "▶ Pronounce / Play", `data-id="${h(v.id)}"`, "primary small")}${action("edit-vocab", "Edit", `data-id="${h(v.id)}"`, "small")}${select("Mastery", `status-${v.id}`, STATUSES, v.status).replace("<select ", `<select data-mastery="${h(v.id)}" `)}${action("delete-vocab", "Delete", `data-id="${h(v.id)}"`, "subtle danger")}</div><details><summary>${v.sources.length} source${v.sources.length === 1 ? "" : "s"} & examples</summary>${sourceLinks(v)}</details>${state.audio
            .filter((a) => a.ownerType === "vocabulary" && a.ownerId === v.id)
            .map((a) => audioCard(a, v.term))
            .join("")}</article>`,
      )
      .join("") ||
    empty("还没有匹配的词条。可以手动添加，也可以从四科正文选词收录。")
  }</div>`;
}
function reviewPage() {
  const list = state.vocabulary.filter(vocabMatches);
  state.reviewIndex = list.length
    ? Math.min(state.reviewIndex, list.length - 1)
    : 0;
  const v = list[state.reviewIndex];
  const prompt = !v
    ? ""
    : state.mode === "中文 → English"
      ? v.meaning || "（该词尚未填写中文，请先编辑释义）"
      : state.mode === "Listen → English"
        ? "先听发音，再回忆英文和意思。"
        : state.mode === "Example → Expression"
          ? (v.sources[0]?.example || "暂无来源例句").replace(
              new RegExp(v.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
              "______",
            )
          : v.term;
  return `<div class="page-heading"><div><span class="eyebrow">SMALL STEPS, LASTING MEMORY</span><h1>Review</h1><p>回忆、翻卡、再听一遍。按自己的节奏重复练习。</p></div></div>${filters(true)}<div class="inline-voice"><label>Review mode<select id="review-mode">${options(["English → 中文", "中文 → English", "Listen → English", "Example → Expression"], state.mode)}</select></label>${voiceControls()}</div>${v ? `<div class="review-card"><span class="eyebrow">CARD ${state.reviewIndex + 1} OF ${list.length} · ${h(v.status)}</span><h2>${h(prompt)}</h2>${action("vocab-audio", "▶ Listen", `data-id="${h(v.id)}"`, "small")}${state.flipped ? `<div class="review-answer"><h3>${h(v.term)}</h3><p>${h(v.meaning || "尚未填写释义")}</p>${sourceLinks(v)}</div>` : '<p class="muted">先回忆，再翻卡查看答案。</p>'}${action("flip", state.flipped ? "Hide answer" : "Flip card", "", "primary")}<div class="toolbar centered">${STATUSES.map((s) => action("review-status", s, `data-id="${h(v.id)}" data-status="${s}" aria-pressed="${v.status === s}"`, v.status === s ? "active" : "")).join("")}</div><div class="toolbar centered">${action("review-prev", "← Previous")}${action("review-next", "Next →")}</div></div>` : empty("没有匹配的词汇。先添加词汇，或清除筛选条件。")}`;
}
function settingsPage() {
  return `<div class="page-heading"><div><span class="eyebrow">YOUR DATA STAYS WITH YOU</span><h1>Settings & backup</h1><p>无需账号。材料与音频保存在当前浏览器的 IndexedDB 中。</p></div></div><div class="settings-grid"><section class="panel"><h2>Local storage</h2><p id="storage-usage">正在读取存储用量…</p><p>这里的浏览器数据<strong>不是云端备份</strong>。换设备、换浏览器、换网站地址、使用隐私模式或清除网站数据后，不会自动同步或恢复。GitHub Pages 只托管代码。</p><p>请定期导出完整备份，并把文件放在安全位置。浏览器存储有容量限制，也可能被系统清理。</p>${action("persist-storage", "Request persistent storage")}</section><section class="panel"><h2>Export backup</h2><label class="inline"><input type="checkbox" id="include-audio" checked> Include uploaded & generated audio</label><p>JSON 备份包含四科材料、词汇、来源、掌握状态，以及勾选时的全部音频。大型音频备份会占用较多内存。</p>${action("export", "Download full backup", "", "primary")}</section><section class="panel"><h2>Restore backup</h2><p>导入将<strong>替换本浏览器的整个学习资料库</strong>，不是合并。请先导出当前数据。格式或关联校验失败时不会写入。</p><label>Choose backup JSON<input id="backup-file" type="file" accept="application/json,.json"></label>${action("import", "Validate & restore backup")}<p class="small-text">单份导入上限 100 MB。未包含音频的备份只能恢复文字和关联。</p></section><section class="panel"><h2>Speech & privacy</h2><p>Kokoro-82M 在本机浏览器 Worker 中运行，优先 WebGPU，自动回退到 WASM。不使用收费 AI API，也不会上传正文或音频。</p><p>首次朗读会从 Hugging Face / 其 CDN 下载模型，从 jsDelivr 获取推理运行时。建议在 Chrome 或 Edge 中使用。独立发音、全文与逐句朗读共用同一引擎。</p><p>文字修改后保留旧音频并标记版本过期。下载 WAV 可在其他播放器中播放；保存位置选择器需要你在浏览器中授权。</p></section></div>`;
}
function render() {
  urls.forEach((url) => URL.revokeObjectURL(url));
  urls = [];
  const m = currentMaterial();
  const navs = [
    "Dashboard",
    ...SECTIONS,
    "Vocabulary & Expressions",
    "Review",
    "Settings",
  ];
  const icons = ["◫", "R", "L", "W", "S", "Aa", "↻", "⚙"];
  app.innerHTML = `<aside class="sidebar"><a href="#Dashboard" class="brand"><span class="brand-icon">T<span>·</span></span><span>TOEFL<strong>Learning Studio</strong></span></a><p class="nav-caption">MY WORKSPACE</p><nav aria-label="Main navigation">${navs.map((view, i) => `<button data-action="navigate" data-view="${h(view)}" class="nav-item ${view === state.view ? "selected" : ""}" ${view === state.view ? 'aria-current="page"' : ""}><span aria-hidden="true">${icons[i]}</span>${h(view)}</button>`).join("")}</nav><div class="sidebar-bottom"><span class="local-dot"></span> Local-first learning<p>你的材料 · 你的节奏<br>定期备份，安心积累。</p></div></aside><div class="workspace"><header class="topbar"><label class="search"><span aria-hidden="true">⌕</span><input id="global-search" type="search" value="${h(state.search)}" placeholder="Search titles, topics, text & vocabulary…" aria-label="Search all materials and vocabulary"></label><span class="topbar-note">A space to learn, every day.</span></header><main id="main" tabindex="-1">${m ? materialPage(m) : state.materialId ? empty("找不到该材料，可能已删除或未在此浏览器中保存。") : state.view === "Dashboard" ? dashboard() : SECTIONS.includes(state.view) ? library() : state.view === "Vocabulary & Expressions" ? vocabularyPage() : state.view === "Review" ? reviewPage() : settingsPage()}</main><footer>TOEFL Learning Studio <span>Personal practice workspace · Unofficial, not affiliated with ETS</span></footer></div>`;
  attachAudioRules();
  if (state.view === "Settings") storageEstimate();
}
async function markPracticed(materialId) {
  await mutate(["materials"], (stores) => {
    const request = stores.materials.get(materialId);
    request.onsuccess = () => {
      if (!request.result) return;
      const timestamp = new Date().toISOString();
      stores.materials.put({ ...request.result, lastPracticedAt: timestamp });
      const local = state.materials.find((m) => m.id === materialId);
      if (local) local.lastPracticedAt = timestamp;
    };
  });
}
function attachAudioRules() {
  document.querySelectorAll("audio").forEach((audio) => {
    audio.addEventListener("play", () => {
      const id = audio.closest("[data-audio-id]")?.dataset.audioId;
      const record = state.audio.find((a) => a.id === id);
      if (record?.ownerType === "material")
        markPracticed(record.ownerId).catch((error) =>
          flash(error.message, true),
        );
    });
    audio.addEventListener("play", () =>
      document.querySelectorAll("audio").forEach((other) => {
        if (other !== audio) other.pause();
      }),
    );
    audio.addEventListener("error", () =>
      flash(
        "浏览器无法解码这份音频。请尝试 WAV/MP3，或下载后用本地播放器打开。原文件仍保留在资料库。",
        true,
      ),
    );
  });
}
async function storageEstimate() {
  const target = document.querySelector("#storage-usage");
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (target?.isConnected)
      target.textContent = `当前站点用量 ${((usage || 0) / 1048576).toFixed(1)} MB / 浏览器估算容量 ${((quota || 0) / 1048576).toFixed(0)} MB。学习库：${state.materials.length} 条材料，${state.vocabulary.length} 条词汇，${state.audio.length} 份音频。`;
  } catch {
    if (target) target.textContent = "浏览器未提供存储容量估算；请定期备份。";
  }
}
function editorShell(title, content) {
  dialog.innerHTML = `<form id="editor-form"><div class="dialog-heading"><h2>${title}</h2>${action("close-editor", "✕", 'aria-label="Close editor"', "subtle")}</div><div class="dialog-content">${content}</div><div class="dialog-footer"><span>仅保存在当前浏览器 · 请定期备份</span>${action("close-editor", "Cancel")}<button class="primary" type="submit">Save</button></div></form>`;
  if (!dialog.open) dialog.showModal();
}
function answerFields(answer, prefix, number) {
  return `<div class="answer-editor"><div class="two-col">${select("Answer type", `${prefix}.kind`, ["Sample Answer", "My Answer"], answer.kind)}<div class="align-end">${action("remove-answer", "Remove answer", `data-prefix="${prefix}"`, "subtle danger")}</div></div>${area(`Answer ${number + 1}`, `${prefix}.text`, answer.text)}</div>`;
}
function materialEditor(record) {
  editorType = "material";
  editorRecord = record;
  dirty = false;
  paintMaterialEditor();
}
function paintMaterialEditor() {
  const m = editorRecord;
  let content = `<div class="two-col">${field("Title / Session Title *", "title", m.title, "text", 'required maxlength="200"')}${field("Date *", "date", m.date, "date", "required")}${field("Topic", "topic", m.topic, "text", 'list="topic-suggestions" maxlength="120"')}${select("Save as", "status", ["Draft", "Saved"], m.status)}</div><datalist id="topic-suggestions">${[...new Set(["Education", "Technology", "Environment", "Society", ...state.materials.map((m) => m.topic)])].map((s) => `<option value="${h(s)}">`).join("")}</datalist>`;
  if (m.section === "Speaking")
    content += m.questions
      .map(
        (q, i) =>
          `<fieldset><legend>Question ${i + 1} / 4</legend>${area("Question Text", `questions.${i}.text`, q.text)}${q.answers.map((a, n) => answerFields(a, `questions.${i}.answers.${n}`, n)).join("")}${action("add-answer", "+ Add Sample / My Answer", `data-prefix="questions.${i}.answers"`)}</fieldset>`,
      )
      .join("");
  else if (m.section === "Writing")
    content += `${select("Writing type", "type", ["Email", "Academic Discussion"], m.type)}${area("Scenario (Email)", "scenario", m.scenario)}${area("Prompt / Professor's Question", "prompt", m.prompt)}${area("Student Responses (optional)", "studentResponses", m.studentResponses)}${m.answers.map((a, i) => answerFields(a, `answers.${i}`, i)).join("")}${action("add-answer", "+ Add Sample / My Answer", 'data-prefix="answers"')}`;
  else
    content += `${m.section === "Listening" ? field("Listening Type (optional)", "type", m.type) : ""}${area(m.section === "Reading" ? "English Passage" : "Transcript", "body", m.body, 'class="long-text"')}${m.section === "Listening" ? '<label>Original Audio (optional)<input id="original-file" type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac,.webm"></label><p class="small-text">音频本体保存到数据库，不保存临时文件路径。</p>' : ""}`;
  content += `${field("Source (optional)", "source", m.source)}${area("Study notes", "notes", m.notes)}`;
  editorShell(
    `${h(m.section)} · ${state.materials.some((r) => r.id === m.id) ? "Edit material" : "New material"}`,
    content,
  );
}
function syncEditor() {
  for (const [name, value] of new FormData(dialog.querySelector("form"))) {
    if (
      typeof value !== "string" ||
      !/^(title|date|topic|status|type|scenario|prompt|studentResponses|body|source|notes|questions|answers)(\.|$)/.test(
        name,
      )
    )
      continue;
    const path = name.split(".");
    let target = editorRecord;
    for (const key of path.slice(0, -1)) target = target[key];
    target[path.at(-1)] = value;
  }
  const file = dialog.querySelector("#original-file")?.files[0];
  if (file) sourceFile = file;
}
function openVocabEditor(record = null, source = null, term = "") {
  editorType = "vocabulary";
  editorRecord = record
    ? structuredClone(record)
    : {
        id: uid(),
        kind: state.tab,
        term,
        meaning: "",
        pos: "",
        ipa: "",
        translation: "",
        notes: "",
        status: "New",
        addedAt: today(),
        sources: [],
      };
  editorSource = source;
  dirty = false;
  const v = editorRecord;
  const m = source
    ? state.materials.find((m) => m.id === source.materialId)
    : null;
  editorShell(
    record ? "Edit vocabulary / expression" : "Add vocabulary & expressions",
    `<div class="two-col">${select("Collection", "kind", ["Vocabulary", "Expressions"], v.kind)}${select("Mastery", "status", STATUSES, v.status)}</div>${field("Word / Phrase / Expression", "term", v.term, "text", record ? "required" : "")}${area("中文释义", "meaning", v.meaning)}<div class="two-col">${field("Part of Speech (optional)", "pos", v.pos)}${field("IPA (optional)", "ipa", v.ipa)}</div>${area("Example translation (optional)", "translation", v.translation)}${area("Usage notes", "notes", v.notes)}${
      source
        ? `<div class="panel"><p>Source: ${h(m?.title || source.title)}</p>${area("Source example", "source-example", source.example)}<label>Source block<select id="source-block">${blocks(
            m,
          )
            .map(
              (b) =>
                `<option value="${h(b.id)}" ${b.id === source.blockId ? "selected" : ""}>${h(b.label)}</option>`,
            )
            .join("")}</select></label></div>`
        : ""
    }${!record ? area("Or bulk add (one word - meaning per line)", "bulk", "", 'placeholder="flexibility - 灵活性&#10;play a crucial role in - 在……中发挥重要作用"') : ""}<p class="small-text">不自动猜测释义或音标。同类型同名词会合并来源，不重复建立词条。</p>`,
  );
}
async function originalRecord(file, materialId) {
  const types = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    flac: "audio/flac",
    aac: "audio/aac",
    webm: "audio/webm",
  };
  const mime = file.type.startsWith("audio/")
    ? file.type
    : types[file.name.split(".").at(-1).toLowerCase()];
  if (!mime || !file.size)
    throw new Error(
      "请选择非空的 MP3、WAV、M4A、OGG、FLAC、AAC 或 WebM 音频。",
    );
  return {
    id: uid(),
    ownerType: "material",
    ownerId: materialId,
    blockId: "original",
    kind: "original",
    text: "",
    hash: "",
    voice: "",
    speed: 1,
    filename: file.name,
    createdAt: new Date().toISOString(),
    blob: file.slice(0, file.size, mime),
  };
}
async function saveEditor(event) {
  event.preventDefault();
  const submit = dialog.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    if (editorType === "material") {
      syncEditor();
      editorRecord.title = editorRecord.title.trim();
      if (!editorRecord.title)
        throw new Error("请填写标题。草稿可以保留空正文。");
      editorRecord.updatedAt = new Date().toISOString();
      const material = editorRecord;
      const retainedIds = new Set(blocks(material).map((b) => b.id));
      const audio = sourceFile
        ? await originalRecord(sourceFile, material.id)
        : null;
      await mutate(["materials", "vocabulary", "audio"], (s) => {
        s.materials.put(material);
        for (const v of state.vocabulary.filter((v) =>
          v.sources.some((s) => s.materialId === material.id),
        )) {
          const copy = structuredClone(v);
          copy.sources = copy.sources
            .filter(
              (source) =>
                source.materialId !== material.id ||
                retainedIds.has(source.blockId),
            )
            .map((source) =>
              source.materialId === material.id
                ? {
                    ...source,
                    section: material.section,
                    topic: material.topic,
                    title: material.title,
                    date: material.date,
                  }
                : source,
            );
          s.vocabulary.put(copy);
        }
        for (const a of state.audio.filter(
          (a) =>
            a.ownerType === "material" &&
            a.ownerId === material.id &&
            a.kind === "tts" &&
            !retainedIds.has(a.blockId),
        ))
          s.audio.delete(a.id);
        if (audio) s.audio.put(audio);
      });
      await reloadData();
      dialog.close();
      dirty = false;
      sourceFile = null;
      navigate(material.section, material.id);
      flash("材料已保存到本浏览器。");
    } else {
      const form = new FormData(dialog.querySelector("form"));
      const entry = { ...editorRecord };
      for (const key of [
        "kind",
        "term",
        "meaning",
        "pos",
        "ipa",
        "translation",
        "notes",
        "status",
      ])
        entry[key] = String(form.get(key) || "").trim();
      const items = String(form.get("bulk") || "").trim()
        ? parseVocabulary(String(form.get("bulk")))
        : [{ term: entry.term, meaning: entry.meaning }];
      if (items.some((i) => !i.term))
        throw new Error("请填写词汇或表达，或输入批量列表。");
      let source = editorSource;
      if (source)
        source = {
          ...source,
          example: String(form.get("source-example") || ""),
          blockId: dialog.querySelector("#source-block").value,
        };
      const records = structuredClone(state.vocabulary);
      const changed = [];
      for (const item of items) {
        const candidate = { ...entry, ...item };
        const existingId = records.find((r) => r.id === candidate.id);
        const collision = records.find(
          (r) =>
            r.id !== candidate.id &&
            r.kind === candidate.kind &&
            r.term.trim().toLowerCase().replace(/\s+/g, " ") ===
              candidate.term.toLowerCase().replace(/\s+/g, " "),
        );
        if (existingId && collision)
          throw new Error(
            "该名称已有词条。请取消改名，向已有词条添加来源；避免丢失音频与学习状态。",
          );
        let merged;
        if (existingId && items.length === 1) {
          merged = candidate;
          if (
            source &&
            !merged.sources.some(
              (s) =>
                s.materialId === source.materialId &&
                s.blockId === source.blockId &&
                s.example === source.example,
            )
          )
            merged.sources.push(source);
        } else
          merged = mergeVocabulary(
            records,
            { ...candidate, id: uid() },
            source,
          );
        const index = records.findIndex((v) => v.id === merged.id);
        if (index < 0) records.push(merged);
        else records[index] = merged;
        changed.push(merged);
      }
      await mutate(["vocabulary"], (s) =>
        changed.forEach((v) => s.vocabulary.put(v)),
      );
      await reloadData();
      dialog.close();
      dirty = false;
      render();
      flash(`${items.length} 条词汇已保存，来源已关联。`);
    }
  } catch (error) {
    flash(error.message, true);
  } finally {
    submit.disabled = false;
  }
}
dialog.addEventListener("submit", saveEditor);
dialog.addEventListener("input", () => {
  dirty = true;
});
dialog.addEventListener("cancel", (event) => {
  if (dirty && !confirm("放弃尚未保存的修改？")) event.preventDefault();
});
window.addEventListener("beforeunload", (event) => {
  if (dirty || state.busy) {
    event.preventDefault();
    event.returnValue = "";
  }
});

async function playSaved(record) {
  const rendered = [...document.querySelectorAll("[data-audio-id]")].find(
    (node) => node.dataset.audioId === record.id,
  );
  if (rendered) {
    const audio = rendered.querySelector("audio");
    audio.currentTime = 0;
    await audio.play();
    rendered.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } else {
    const container = document.querySelector("#quick-player");
    const old = container.querySelector("audio");
    if (old) {
      old.pause();
      URL.revokeObjectURL(old.src);
    }
    container.innerHTML = `<div><strong>${h(record.text)}</strong><audio controls></audio>${action("close-quick", "✕", 'aria-label="Close player"', "subtle")}</div>`;
    const audio = container.querySelector("audio");
    audio.src = URL.createObjectURL(record.blob);
    audio.addEventListener("play", () =>
      document.querySelectorAll("audio").forEach((other) => {
        if (other !== audio) other.pause();
      }),
    );
    await audio.play();
  }
}
async function speak(ownerType, ownerId, blockId, text, sourceText = text) {
  if (!text.trim()) throw new Error("请先填写需要朗读的英文内容。");
  if (state.busy) throw new Error("正在生成，请稍候或点击 Cancel。");
  // Capture settings before any await so a later UI change cannot mislabel a result.
  const voice = state.voice,
    speed = state.speed;
  state.busy = true;
  const panel = document.querySelector("#generation-panel");
  try {
    const hash = await textHash(text);
    const cached = state.audio.find(
      (a) =>
        a.ownerType === ownerType &&
        a.ownerId === ownerId &&
        a.blockId === blockId &&
        a.hash === hash &&
        a.voice === voice &&
        a.speed === speed &&
        a.kind === "tts",
    );
    if (cached) {
      await playSaved(cached);
      flash("正在播放已保存的音频，没有重新生成。");
      return;
    }
    panel.hidden = false;
    document.querySelector("#generation-message").textContent =
      "正在加载本地语音引擎…";
    document.querySelector("#generation-progress").value = 0;
    const result = await generate(text, voice, speed);
    const record = {
      id: uid(),
      ownerType,
      ownerId,
      blockId,
      text,
      sourceText,
      hash,
      voice,
      speed,
      createdAt: new Date().toISOString(),
      kind: "tts",
      scope: text === sourceText ? "full" : "excerpt",
      filename: `${safeName(text.slice(0, 45))}-${voice}-${speed}.wav`,
      duration: result.duration,
      blob: new Blob([result.wav], { type: "audio/wav" }),
    };
    // Navigation is allowed during inference; save only to the captured owner that still exists.
    await reloadData();
    const owner =
      ownerType === "material"
        ? state.materials.find((m) => m.id === ownerId)
        : state.vocabulary.find((v) => v.id === ownerId);
    if (
      !owner ||
      (ownerType === "material" && !blocks(owner).some((b) => b.id === blockId))
    )
      throw new Error("来源已删除，生成结果未写入资料库。");
    await put("audio", record);
    await reloadData();
    render();
    try {
      await playSaved(record);
      flash(
        `已生成并保存 ${result.duration.toFixed(1)} 秒音频（${result.backend.toUpperCase()}），正在播放。`,
      );
    } catch {
      flash(
        `已生成并保存 ${result.duration.toFixed(1)} 秒音频。浏览器要求再次点击播放。`,
      );
    }
  } catch (error) {
    throw new Error(
      `${error.message}${/fetch|load|network/i.test(error.message) ? " 请在浏览器开发者工具 Network 中检查 huggingface.co、模型 CDN 和 cdn.jsdelivr.net 的失败请求。" : ""}`,
    );
  } finally {
    state.busy = false;
    panel.hidden = true;
  }
}
onTtsProgress((message) => {
  const label = document.querySelector("#generation-message"),
    progress = document.querySelector("#generation-progress");
  if (message.type === "backend")
    label.textContent = `${message.backend.toUpperCase()} · ${message.stage === "ready" ? "引擎已就绪" : "正在加载引擎"}`;
  if (message.type === "progress") {
    const ratio =
      message.phase === "load"
        ? message.progress
        : message.done / message.total;
    progress.value = Math.round((ratio || 0) * 100);
    label.textContent =
      message.phase === "load"
        ? `下载模型 ${progress.value}% · 首次加载后缓存`
        : `正在合成 ${message.done} / ${message.total} 个片段`;
  }
});
document
  .querySelector("#cancel-generation")
  .addEventListener("click", cancelGeneration);

async function deleteMaterial(id) {
  if (
    !confirm(
      "删除此材料及其音频？全局词汇和掌握状态会保留，该材料的来源关联将移除。",
    )
  )
    return;
  if (state.busy) throw new Error("请先取消当前音频生成，再删除材料。");
  const m = state.materials.find((m) => m.id === id);
  await mutate(["materials", "vocabulary", "audio"], (s) => {
    s.materials.delete(id);
    state.vocabulary
      .filter((v) => v.sources.some((source) => source.materialId === id))
      .forEach((v) =>
        s.vocabulary.put({
          ...v,
          sources: v.sources.filter((source) => source.materialId !== id),
        }),
      );
    state.audio
      .filter((a) => a.ownerType === "material" && a.ownerId === id)
      .forEach((a) => s.audio.delete(a.id));
  });
  await reloadData();
  navigate(m.section);
  flash("材料及音频已删除；独立词条已保留。");
}
async function saveAudioAs(id) {
  const record = state.audio.find((a) => a.id === id);
  if (!record) throw new Error("找不到音频。");
  if (!supportsFsAccess()) {
    downloadBlob(record.blob, record.filename);
    return;
  }
  // Call the native picker immediately in the user click, before awaiting anything else.
  let handle;
  try {
    handle = await pickSaveFile(
      record.filename,
      record.blob.type,
      record.filename.split(".").at(-1),
    );
  } catch (error) {
    if (error.name === "AbortError") return;
    downloadBlob(record.blob, record.filename);
    flash("无法打开保存位置选择器，已改用浏览器下载。");
    return;
  }
  try {
    await writeToHandle(handle, record.blob);
    flash("音频已写入所选位置。");
  } catch {
    downloadBlob(record.blob, record.filename);
    flash("未能写入所选位置，已改用浏览器下载。", true);
  }
}
async function handleAction(button) {
  const { action: name, id, block, section, prefix } = button.dataset;
  if (name === "navigate") navigate(button.dataset.view);
  else if (name === "open-material")
    navigate(state.materials.find((m) => m.id === id).section, id);
  else if (name === "back-library") navigate(currentMaterial().section);
  else if (name === "new-material") {
    sourceFile = null;
    materialEditor(newMaterial(section));
  } else if (name === "edit-material") {
    sourceFile = null;
    materialEditor(structuredClone(state.materials.find((m) => m.id === id)));
  } else if (name === "close-editor") {
    if (!dirty || confirm("放弃尚未保存的修改？")) {
      dirty = false;
      dialog.close();
    }
  } else if (name === "add-answer" || name === "remove-answer") {
    syncEditor();
    const path = prefix.split(".");
    let target = editorRecord;
    for (const key of name === "add-answer" ? path : path.slice(0, -1))
      target = target[key];
    if (name === "add-answer")
      target.push({ id: uid(), kind: "Sample Answer", text: "" });
    else {
      if (
        !confirm(
          "移除此回答？保存材料后，对应音频和词汇的此处来源关联也会移除。",
        )
      )
        return;
      target.splice(Number(path.at(-1)), 1);
    }
    dirty = true;
    const scroll = dialog.querySelector(".dialog-content").scrollTop;
    paintMaterialEditor();
    dialog.querySelector(".dialog-content").scrollTop = scroll;
  } else if (name === "delete-material") await deleteMaterial(id);
  else if (name === "generate-block") {
    const b = currentBlock(block);
    await speak("material", state.materialId, block, b.text);
  } else if (name === "sentence-audio") {
    const b = currentBlock(block);
    await speak(
      "material",
      state.materialId,
      block,
      sentences(b.text)[Number(button.dataset.index)],
      b.text,
    );
  } else if (name === "collect-selection" || name === "read-selection") {
    const selected = state.selection;
    if (!selected || selected.materialId !== state.materialId)
      throw new Error("请先在正文区域选中英文词句。");
    const b = currentBlock(selected.blockId);
    if (name === "read-selection")
      await speak("material", state.materialId, b.id, selected.text, b.text);
    else
      openVocabEditor(
        null,
        sourceFor(currentMaterial(), b.id, selected.example),
        selected.text,
      );
  } else if (name === "new-vocab") {
    const m = state.materials.find((m) => m.id === button.dataset.material);
    const b = m ? blocks(m)[0] : null;
    openVocabEditor(null, m ? sourceFor(m, b.id, "") : null);
  } else if (name === "edit-vocab")
    openVocabEditor(state.vocabulary.find((v) => v.id === id));
  else if (name === "vocab-audio") {
    const v = state.vocabulary.find((v) => v.id === id);
    await speak("vocabulary", id, "term", v.term);
  } else if (name === "delete-vocab") {
    if (!confirm("删除这个词条、全部来源关联和独立发音？材料正文不会改变。"))
      return;
    if (state.busy) throw new Error("请先取消生成，再删除词条。");
    await mutate(["vocabulary", "audio"], (s) => {
      s.vocabulary.delete(id);
      state.audio
        .filter((a) => a.ownerType === "vocabulary" && a.ownerId === id)
        .forEach((a) => s.audio.delete(a.id));
    });
    await reloadData();
    render();
  } else if (name === "tab") {
    state.tab = button.dataset.tab;
    render();
  } else if (name === "source") {
    if (state.materialId !== id) {
      state.materialId = id;
      location.hash = `#material/${encodeURIComponent(id)}`;
    } else render();
    setTimeout(
      () =>
        document
          .getElementById(`block-${block}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" }),
      80,
    );
  } else if (name === "save-audio") await saveAudioAs(id);
  else if (name === "delete-audio") {
    if (!confirm("删除这份音频？文字和其他语音版本会保留。")) return;
    await remove("audio", id);
    await reloadData();
    render();
  } else if (name === "replay") {
    const audio = button.closest(".audio-card").querySelector("audio");
    audio.currentTime = 0;
    await audio.play();
  } else if (name === "close-quick") {
    const audio = document.querySelector("#quick-player audio");
    audio.pause();
    URL.revokeObjectURL(audio.src);
    document.querySelector("#quick-player").innerHTML = "";
  } else if (name === "upload-original")
    document.querySelector("#upload-audio").click();
  else if (name === "clear-filters") {
    state.topic =
      state.date =
      state.status =
      state.type =
      state.section =
      state.search =
        "";
    state.flipped = false;
    render();
  } else if (name === "flip") {
    state.flipped = !state.flipped;
    render();
  } else if (name === "review-prev" || name === "review-next") {
    const length = state.vocabulary.filter(vocabMatches).length;
    state.reviewIndex =
      (state.reviewIndex + (name === "review-next" ? 1 : -1) + length) % length;
    state.flipped = false;
    render();
  } else if (name === "review-status") {
    const v = state.vocabulary.find((v) => v.id === id);
    await put("vocabulary", { ...v, status: button.dataset.status });
    await reloadData();
    state.flipped = false;
    render();
  } else if (name === "persist-storage") {
    const granted = await navigator.storage?.persist?.();
    flash(
      granted
        ? "浏览器已允许持久存储。仍建议定期备份。"
        : "浏览器尚未允许持久存储。请定期导出备份。",
    );
  } else if (name === "export") {
    if (state.busy) throw new Error("请等待生成完成后导出，以包含完整结果。");
    const includeAudio = document.querySelector("#include-audio").checked;
    button.disabled = true;
    try {
      const backup = await exportBackup(includeAudio);
      downloadBlob(
        new Blob([JSON.stringify(backup)], { type: "application/json" }),
        `toefl-learning-studio-${today()}${includeAudio ? "-with-audio" : "-text-only"}.json`,
      );
      flash("已导出备份。请妥善保存该 JSON 文件。");
    } finally {
      button.disabled = false;
    }
  } else if (name === "import") {
    if (state.busy) throw new Error("请先等待或取消音频生成，再导入备份。");
    const file = document.querySelector("#backup-file").files[0];
    if (!file) throw new Error("请先选择备份 JSON 文件。");
    if (file.size > 100 * 1024 * 1024)
      throw new Error(
        "此备份超过 100 MB 导入上限。请在保存原数据的浏览器中使用较小的备份。",
      );
    if (
      !confirm(
        "导入会替换此浏览器的全部材料、词汇和音频。确定已备份当前数据并继续？",
      )
    )
      return;
    button.disabled = true;
    try {
      await importBackup(JSON.parse(await file.text()));
      await reloadData();
      await loadPrefs();
      render();
      flash("备份已恢复，材料、来源、学习状态及所含音频均已写入。");
    } finally {
      button.disabled = false;
    }
  }
}
document.addEventListener("click", (event) => {
  if (event.target.closest(".skip-link")) {
    event.preventDefault();
    document.querySelector("#main")?.focus();
    return;
  }
  const button = event.target.closest("[data-action]");
  if (button)
    handleAction(button).catch((error) =>
      flash(
        error.name === "QuotaExceededError"
          ? "本地存储空间不足。请先备份，再清理不需要的音频。"
          : error.message,
        true,
      ),
    );
});
document.addEventListener("change", async (event) => {
  const el = event.target;
  try {
    if (el.dataset.filter) {
      state[el.dataset.filter] = el.value;
      state.reviewIndex = 0;
      state.flipped = false;
      render();
    } else if (el.id === "voice" || el.id === "generation-speed") {
      if (el.id === "voice") state.voice = el.value;
      else state.speed = Number(el.value);
      await put("settings", {
        id: "speech",
        voice: state.voice,
        speed: state.speed,
      });
    } else if (el.dataset.mastery) {
      const v = state.vocabulary.find((v) => v.id === el.dataset.mastery);
      await put("vocabulary", { ...v, status: el.value });
      await reloadData();
    } else if (el.hasAttribute("data-loop"))
      el.closest(".audio-card").querySelector("audio").loop = el.checked;
    else if (el.hasAttribute("data-playback-speed"))
      el.closest(".audio-card").querySelector("audio").playbackRate = Number(
        el.value,
      );
    else if (el.id === "review-mode") {
      state.mode = el.value;
      state.flipped = false;
      render();
    } else if (el.id === "upload-audio" && el.files[0]) {
      const m = currentMaterial();
      if (!m) return;
      await put("audio", await originalRecord(el.files[0], m.id));
      await reloadData();
      render();
      el.value = "";
      flash("原始音频已与材料一起保存在本浏览器。");
    }
  } catch (error) {
    flash(error.message, true);
  }
});
let searchTimer;
document.addEventListener("input", (event) => {
  if (event.target.id !== "global-search") return;
  const value = event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = value;
    // Global search always includes all four subjects and vocabulary.
    state.materialId = null;
    state.view = "Dashboard";
    state.topic = state.date = state.status = state.type = state.section = "";
    render();
    const search = document.querySelector("#global-search");
    search.focus();
    search.setSelectionRange(value.length, value.length);
  }, 220);
});
document.addEventListener("selectionchange", () => {
  if (dialog.open || !state.materialId) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;
  const start =
    selection.anchorNode?.parentElement?.closest("[data-text-block]");
  const end = selection.focusNode?.parentElement?.closest("[data-text-block]");
  if (!start || start !== end) return;
  const text = selection.toString().trim();
  if (!text) return;
  const b = currentBlock(start.dataset.textBlock);
  const example = sentences(b.text).find((s) => s.includes(text)) || text;
  state.selection = {
    materialId: state.materialId,
    blockId: b.id,
    text,
    example,
  };
  const preview = document.querySelector("#selection-preview");
  if (preview) preview.textContent = text;
});
async function loadPrefs() {
  const pref = (await all("settings")).find((p) => p.id === "speech");
  if (pref) {
    state.voice = VOICE_GROUPS.some((g) =>
      g.voices.some((v) => v.id === pref.voice),
    )
      ? pref.voice
      : DEFAULT_VOICE;
    state.speed = [0.5, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.5, 2].includes(pref.speed)
      ? pref.speed
      : 1;
  }
}
try {
  await reloadData();
  await loadPrefs();
  await primeMru();
  readRoute();
} catch (error) {
  app.innerHTML = `<main class="startup-error"><h1>无法打开本地学习资料库</h1><p>${h(error.message)}</p><p>请检查浏览器是否允许网站存储，退出隐私模式后重试。不要清除已有网站数据，先保留或导出备份。</p></main>`;
}
