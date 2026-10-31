import test from "node:test";
import assert from "node:assert/strict";
import {
  newMaterial,
  blocks,
  mergeVocabulary,
  parseVocabulary,
  sourceFor,
  textHash,
  validateBackup,
} from "../src/studio-db.js";

test("interviews keep four ordered questions with stable independent answer ids", () => {
  const session = newMaterial("Speaking");
  assert.equal(session.questions.length, 4);
  const ids = blocks(session).map((b) => b.id);
  assert.equal(new Set(ids).size, 8);
  session.questions[0].text = "Why learn English?";
  const clone = structuredClone(session);
  assert.deepEqual(
    blocks(clone).map((b) => b.id),
    ids,
  );
  assert.equal(blocks(clone)[0].text, "Why learn English?");
});
test("duplicate vocabulary keeps mastery, audio identity and multiple source examples", () => {
  const m = newMaterial("Reading");
  const first = mergeVocabulary(
    [],
    { term: "Exchange ideas", kind: "Expressions", meaning: "交流想法" },
    sourceFor(m, "body", "We exchange ideas."),
  );
  first.status = "Mastered";
  const second = mergeVocabulary(
    [first],
    { term: "  exchange   IDEAS ", kind: "Expressions" },
    sourceFor(m, "body", "Students exchange ideas."),
  );
  assert.equal(second.id, first.id);
  assert.equal(second.status, "Mastered");
  assert.equal(second.meaning, "交流想法");
  assert.equal(second.sources.length, 2);
  const third = mergeVocabulary(
    [second],
    { term: "exchange ideas", kind: "Expressions" },
    second.sources[1],
  );
  assert.equal(third.sources.length, 2);
});
test("bulk parser preserves multiword terms and hyphenated words", () => {
  assert.deepEqual(
    parseVocabulary(
      "flexibility - 灵活性\n\nplay a crucial role in — 在……中发挥重要作用\nwell-being - 幸福\nindependent",
    ),
    [
      { term: "flexibility", meaning: "灵活性" },
      { term: "play a crucial role in", meaning: "在……中发挥重要作用" },
      { term: "well-being", meaning: "幸福" },
      { term: "independent", meaning: "" },
    ],
  );
});
test("audio hashes change with content and are deterministic", async () => {
  assert.equal(await textHash("Hello."), await textHash("Hello."));
  assert.notEqual(await textHash("Hello."), await textHash("Hello!"));
});
test("backup validation rejects broken sources, malformed interviews and orphaned audio", () => {
  const material = newMaterial("Reading");
  const v = mergeVocabulary(
    [],
    { term: "hello", kind: "Vocabulary" },
    sourceFor(material, "body", "Hello."),
  );
  const backup = {
    format: "toefl-learning-studio",
    version: 1,
    materials: [material],
    vocabulary: [v],
    audio: [],
    settings: [],
  };
  assert.equal(validateBackup(structuredClone(backup)).vocabulary.length, 1);
  const broken = structuredClone(backup);
  broken.vocabulary[0].sources[0].materialId = "missing";
  assert.throws(() => validateBackup(broken), /关联无效/);
  const questions = structuredClone(backup);
  questions.materials[0].questions.pop();
  assert.throws(() => validateBackup(questions));
  const duplicate = structuredClone(backup);
  duplicate.materials.push(material);
  assert.throws(() => validateBackup(duplicate));
  const badAudio = structuredClone(backup);
  badAudio.audio = [{ id: "orphan" }];
  assert.throws(() => validateBackup(badAudio));
  assert.throws(() => validateBackup({ ...backup, version: 9 }));
});
