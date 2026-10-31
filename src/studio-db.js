export const SECTIONS = ["Reading", "Listening", "Writing", "Speaking"];
export const STATUSES = ["New", "Learning", "Mastered"];
export const uid = () => crypto.randomUUID();
export const today = () => new Intl.DateTimeFormat("en-CA").format(new Date());
export const normalize = (s) =>
  s.trim().toLocaleLowerCase("en").replace(/\s+/g, " ");
const DB_NAME = "toefl-learning-studio";
const STORES = ["materials", "vocabulary", "audio", "settings"];
let connection;

export function openDatabase() {
  return (connection ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () =>
      STORES.forEach((name) =>
        request.result.createObjectStore(name, { keyPath: "id" }),
      );
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      connection = null;
      reject(request.error);
    };
    request.onblocked = () => {
      connection = null;
      reject(new Error("请关闭其他网站标签页，再重试数据库升级。"));
    };
  }));
}

export async function all(store) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const request = tx.objectStore(store).getAll();
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
  });
}

// Resolve only after commit: a successful put request alone does not prove persistence.
export async function mutate(stores, callback) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error || new Error("保存被取消，原有数据保持不变。"));
    tx.onerror = () => reject(tx.error);
    try {
      callback(Object.fromEntries(stores.map((s) => [s, tx.objectStore(s)])));
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}

export const put = (store, record) =>
  mutate([store], (s) => s[store].put(record));
export const remove = (store, id) =>
  mutate([store], (s) => s[store].delete(id));

export function blocks(material) {
  if (material.section === "Speaking")
    return material.questions.flatMap((q, i) => [
      { id: q.id, label: `Question ${i + 1}`, text: q.text },
      ...q.answers.map((a, n) => ({
        id: a.id,
        label: `Q${i + 1} · ${a.kind} ${n + 1}`,
        text: a.text,
      })),
    ]);
  if (material.section === "Writing")
    return [
      {
        id: "prompt",
        label: material.type === "Email" ? "Prompt" : "Professor's Question",
        text: material.prompt,
      },
      ...material.answers.map((a, n) => ({
        id: a.id,
        label: `${a.kind} ${n + 1}`,
        text: a.text,
      })),
    ];
  return [
    {
      id: "body",
      label:
        material.section === "Listening" ? "Transcript" : "English Passage",
      text: material.body,
    },
  ];
}

export function newMaterial(section) {
  const answer = () => ({ id: uid(), kind: "Sample Answer", text: "" });
  return {
    id: uid(),
    section,
    date: today(),
    topic: "",
    title: "",
    status: "Draft",
    source: "",
    notes: "",
    body: "",
    type: section === "Writing" ? "Email" : "",
    scenario: "",
    prompt: "",
    studentResponses: "",
    answers: [answer()],
    questions: Array.from({ length: 4 }, () => ({
      id: uid(),
      text: "",
      answers: [answer()],
    })),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function sourceFor(material, blockId, example) {
  return {
    materialId: material.id,
    blockId,
    example,
    section: material.section,
    topic: material.topic,
    title: material.title,
    date: material.date,
  };
}

export function mergeVocabulary(records, entry, source) {
  const found = records.find(
    (v) => v.kind === entry.kind && normalize(v.term) === normalize(entry.term),
  );
  const result = found
    ? structuredClone(found)
    : {
        id: uid(),
        kind: "Vocabulary",
        term: "",
        meaning: "",
        pos: "",
        ipa: "",
        translation: "",
        notes: "",
        status: "New",
        addedAt: today(),
        sources: [],
        ...entry,
      };
  if (found && !result.meaning && entry.meaning) result.meaning = entry.meaning;
  if (
    source &&
    !result.sources.some(
      (s) =>
        s.materialId === source.materialId &&
        s.blockId === source.blockId &&
        s.example === source.example,
    )
  )
    result.sources.push(source);
  return result;
}

export function parseVocabulary(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = /\s+[-–—]\s+|\s*[：:]\s*/.exec(line);
      return separator
        ? {
            term: line.slice(0, separator.index).trim(),
            meaning: line.slice(separator.index + separator[0].length).trim(),
          }
        : { term: line, meaning: "" };
    });
}

export async function textHash(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let raw = "";
  for (let i = 0; i < bytes.length; i += 16384)
    raw += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(raw);
}

export async function exportBackup(includeAudio = true) {
  const db = await openDatabase();
  // A single transaction gives a consistent snapshot across material/source/audio changes.
  const snapshot = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORES, "readonly");
    const requests = STORES.map((s) => [s, tx.objectStore(s).getAll()]);
    tx.oncomplete = () =>
      resolve(Object.fromEntries(requests.map(([s, r]) => [s, r.result])));
    tx.onerror = () => reject(tx.error);
  });
  snapshot.audio = includeAudio
    ? await Promise.all(
        snapshot.audio.map(async ({ blob, ...record }) => ({
          ...record,
          mime: blob.type,
          data: toBase64(await blob.arrayBuffer()),
        })),
      )
    : [];
  return {
    format: "toefl-learning-studio",
    version: 1,
    exportedAt: new Date().toISOString(),
    includeAudio,
    ...snapshot,
  };
}

export function validateBackup(data) {
  const fail = () => {
    throw new Error("备份格式或关联无效；现有数据未更改。");
  };
  if (
    data?.format !== "toefl-learning-studio" ||
    data.version !== 1 ||
    !STORES.every((s) => Array.isArray(data[s]))
  )
    fail();
  const string = (s) => typeof s === "string";
  for (const store of STORES) {
    if (
      data[store].some((r) => !r || !string(r.id) || !r.id) ||
      new Set(data[store].map((r) => r.id)).size !== data[store].length
    )
      fail();
  }
  for (const m of data.materials) {
    if (
      !SECTIONS.includes(m.section) ||
      ![
        m.title,
        m.topic,
        m.date,
        m.body,
        m.prompt,
        m.scenario,
        m.studentResponses,
        m.notes,
        m.source,
        m.type,
        m.createdAt,
        m.updatedAt,
      ].every(string) ||
      !["Draft", "Saved"].includes(m.status)
    )
      fail();
    const validAnswer = (a) =>
      a &&
      string(a.id) &&
      !!a.id &&
      string(a.text) &&
      ["Sample Answer", "My Answer"].includes(a.kind);
    if (
      !Array.isArray(m.answers) ||
      !m.answers.every(validAnswer) ||
      !Array.isArray(m.questions) ||
      m.questions.length !== 4 ||
      !m.questions.every(
        (q) =>
          string(q.id) &&
          q.id &&
          string(q.text) &&
          Array.isArray(q.answers) &&
          q.answers.every(validAnswer),
      )
    )
      fail();
    const ids = blocks(m).map((b) => b.id);
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) fail();
  }
  const materials = new Map(data.materials.map((m) => [m.id, m]));
  for (const v of data.vocabulary) {
    if (
      ![
        v.term,
        v.meaning,
        v.pos,
        v.ipa,
        v.notes,
        v.translation,
        v.addedAt,
      ].every(string) ||
      !v.term.trim() ||
      !STATUSES.includes(v.status) ||
      !["Vocabulary", "Expressions"].includes(v.kind) ||
      !Array.isArray(v.sources)
    )
      fail();
    for (const s of v.sources) {
      if (
        ![
          s.materialId,
          s.blockId,
          s.example,
          s.section,
          s.topic,
          s.title,
          s.date,
        ].every(string)
      )
        fail();
      if (
        !materials.has(s.materialId) ||
        !blocks(materials.get(s.materialId)).some((b) => b.id === s.blockId)
      )
        fail();
    }
  }
  const vocabIds = new Set(data.vocabulary.map((v) => v.id));
  for (const a of data.audio) {
    if (
      ![
        a.ownerId,
        a.blockId,
        a.text,
        a.hash,
        a.voice,
        a.createdAt,
        a.filename,
      ].every(string) ||
      !["tts", "original"].includes(a.kind) ||
      !["material", "vocabulary"].includes(a.ownerType) ||
      !Number.isFinite(a.speed) ||
      a.speed < 0.5 ||
      a.speed > 2 ||
      !string(a.data) ||
      !string(a.mime) ||
      !/^audio\//.test(a.mime)
    )
      fail();
    if (
      a.ownerType === "material"
        ? !materials.has(a.ownerId) ||
          (a.kind === "tts" &&
            !blocks(materials.get(a.ownerId)).some((b) => b.id === a.blockId))
        : !vocabIds.has(a.ownerId)
    )
      fail();
    try {
      a.blob = new Blob(
        [Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0))],
        { type: a.mime },
      );
    } catch {
      fail();
    }
    if (!a.blob.size) fail();
    delete a.data;
    delete a.mime;
  }
  return data;
}

export async function importBackup(data) {
  const validated = validateBackup(data);
  await mutate(STORES, (stores) => {
    for (const name of STORES) {
      stores[name].clear();
      validated[name].forEach((record) => stores[name].put(record));
    }
  });
}
