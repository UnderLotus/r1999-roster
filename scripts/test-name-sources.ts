import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadJapaneseNameOverrides,
  parseJapaneseNameOverrides,
} from "./fetch-name-sources";
import {
  installNameSourceCache,
  loadNameSourceCache,
  replaceFileWithRollback,
  serializeNameSourceSnapshot,
} from "./name-source-cache";
import {
  createNameSourceSnapshot,
  NAME_LANGS,
  NameConfigurationError,
  NameSourceError,
  normalizeFandomKoreanSource,
  parseGlobalSource,
  parseKornblumeSource,
  parseWikiRuJapaneseSource,
  type NameLang,
  validateNameSourceSnapshot,
} from "./name-source";
import { runNameSync } from "./build-names";

assert.throws(
  () => parseJapaneseNameOverrides("not-json", "fixture overrides"),
  (error) =>
    error instanceof NameConfigurationError &&
    error.recoverableWithLkg === false,
  "malformed local config is non-recoverable"
);
const configDirectory = await mkdtemp(
  path.join(os.tmpdir(), "r1999-name-config-")
);
try {
  const malformedConfig = path.join(configDirectory, "malformed.json");
  await writeFile(malformedConfig, "not-json");
  for (const file of [malformedConfig, path.join(configDirectory, "missing.json")]) {
    await assert.rejects(
      () => loadJapaneseNameOverrides(file),
      (error) =>
        error instanceof NameConfigurationError &&
        error.recoverableWithLkg === false
    );
  }
} finally {
  await rm(configDirectory, { recursive: true, force: true });
}
console.log("ok: missing and malformed local config fail consistently without LKG eligibility");

const rawKornblumeNames = {} as Record<NameLang, string>;
for (const lang of NAME_LANGS) {
  rawKornblumeNames[lang] = JSON.stringify(
    Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `english-${index}`,
        lang === "en-US" ? `English ${index}` : `${lang} ${index}`,
      ])
    )
  );
}
const rawKornblumeArcanists = JSON.stringify(
  Array.from({ length: 100 }, (_, index) => ({
    Id: index + 1,
    Name: `English ${index}`,
    Rarity: (index % 6) + 1,
  }))
);
const kornblume = parseKornblumeSource(
  rawKornblumeNames,
  rawKornblumeArcanists
);
assert.equal(kornblume.arcanists.length, 100);
assert.equal(kornblume.namesByLang["en-US"]["english-2"], "English 2");
console.log("ok: Kornblume raw fixtures normalize without transport");

const permutedRawNames = { ...rawKornblumeNames };
const permutedEnglish = JSON.parse(rawKornblumeNames["en-US"]) as Record<
  string,
  string
>;
const alignedKeys = Object.keys(permutedEnglish);
const alignedValues = alignedKeys.map((key) => permutedEnglish[key]);
for (const [index, key] of alignedKeys.entries()) {
  permutedEnglish[key] = alignedValues[(index + 1) % alignedValues.length];
}
permutedRawNames["en-US"] = JSON.stringify(permutedEnglish);
assert.throws(
  () => parseKornblumeSource(permutedRawNames, rawKornblumeArcanists),
  /cross-source coverage failed/,
  "raw validation rejects permuted English values under otherwise shared keys"
);
console.log("ok: raw Kornblume alignment rejects permuted English values");

assert.throws(
  () =>
    parseKornblumeSource(
      { ...rawKornblumeNames, "ko-KR": "{}" },
      rawKornblumeArcanists
    ),
  (error) =>
    error instanceof NameSourceError && error.kind === "validation",
  "truncated Kornblume data is a classified adapter failure"
);
const duplicateArcanists = JSON.parse(rawKornblumeArcanists) as Array<{
  Id: number;
  Name: string;
  Rarity: number;
}>;
duplicateArcanists[1].Id = duplicateArcanists[0].Id;
assert.throws(
  () =>
    parseKornblumeSource(
      rawKornblumeNames,
      JSON.stringify(duplicateArcanists)
    ),
  /duplicate arcanist ID/,
  "duplicate source IDs are rejected"
);
const duplicateSlugArcanists = JSON.parse(rawKornblumeArcanists) as Array<{
  Id: number;
  Name: string;
  Rarity: number;
}>;
duplicateSlugArcanists[1].Name = duplicateSlugArcanists[0].Name;
assert.throws(
  () =>
    parseKornblumeSource(
      rawKornblumeNames,
      JSON.stringify(duplicateSlugArcanists)
    ),
  /duplicate or empty arcanist slug/,
  "duplicate normalized metadata keys are rejected"
);
assert.throws(
  () => parseKornblumeSource(rawKornblumeNames, "not-json"),
  (error) => error instanceof NameSourceError && error.kind === "parse",
  "malformed JSON is distinguishable from validation failures"
);

const globalCharacters = [
  { id: 3003, name: "character_3003" },
  ...Array.from({ length: 99 }, (_, index) => ({
    id: 4000 + index,
    name: `character_${4000 + index}`,
  })),
];
const rawGlobalCharacters = JSON.stringify(globalCharacters);
const rawGlobalLanguages = {} as Record<NameLang, string>;
for (const lang of NAME_LANGS) {
  const characterRows = globalCharacters.map((entry) => ({
    key: entry.name,
    content: `${lang} ${entry.id}`,
  }));
  const fillerRows = Array.from({ length: 9_900 }, (_, index) => ({
    key: `filler_${lang}_${index}`,
    content: `filler ${index}`,
  }));
  rawGlobalLanguages[lang] = JSON.stringify([...characterRows, ...fillerRows]);
}
const globalNamesByLang = parseGlobalSource(
  rawGlobalCharacters,
  rawGlobalLanguages
);
assert.equal(globalNamesByLang["ja-JP"]["3003"], "ja-JP 3003");
console.log("ok: Global character/localization fixtures normalize for every language");

const duplicateGlobalRows = JSON.parse(rawGlobalLanguages["en-US"]) as Array<{
  key: string;
  content: string;
}>;
duplicateGlobalRows[duplicateGlobalRows.length - 1].key =
  duplicateGlobalRows[0].key;
assert.throws(
  () =>
    parseGlobalSource(rawGlobalCharacters, {
      ...rawGlobalLanguages,
      "en-US": JSON.stringify(duplicateGlobalRows),
    }),
  /duplicate localization key/,
  "duplicate localization keys are rejected before normalization"
);
assert.throws(
  () =>
    parseGlobalSource(
      JSON.stringify(globalCharacters.filter((entry) => entry.id !== 3003)),
      rawGlobalLanguages
    ),
  (error) => error instanceof NameSourceError && error.kind === "validation",
  "missing stable launch sentinel rejects a truncated/wrong generation"
);

const wikiMarkdown = Array.from({ length: 30 }, (_, index) => {
  const encoded = Buffer.from(`imgEnglish ${index}_icon`, "utf8").toString("hex");
  return `[icon](attach2/${encoded}.png) Japanese ${index}](target)`;
}).join("\n");
const wikiRuJa = parseWikiRuJapaneseSource(
  wikiMarkdown,
  kornblume.namesByLang["ja-JP"],
  {}
);
assert.equal(wikiRuJa["english-0"], "Japanese 0");
assert.throws(
  () => parseWikiRuJapaneseSource("truncated", {}, {}),
  /is truncated/,
  "WikiRu parser has a meaningful minimum coverage guard"
);

const fandomRows = Array.from({ length: 30 }, (_, index) => ({
  englishName: `English ${index}`,
  wikitext: `{{Character|name_kor=한국어 ${index}\n|other=value}}`,
}));
const fandomKr = normalizeFandomKoreanSource(fandomRows, 0);
assert.equal(fandomKr["english-0"], "한국어 0");
assert.deepEqual(
  normalizeFandomKoreanSource([...fandomRows].reverse(), 0),
  fandomKr,
  "concurrent fetch completion order cannot change normalized cache order"
);
assert.throws(
  () => normalizeFandomKoreanSource(fandomRows, 1),
  (error) => error instanceof NameSourceError && error.kind === "transport",
  "Fandom transport degradation is classified before cache install"
);
console.log("ok: WikiRu and Fandom adapters enforce production coverage");

const snapshot = createNameSourceSnapshot({
  kornblume,
  wikiRuJa,
  fandomKr,
  globalNamesByLang,
});
assert.equal(
  serializeNameSourceSnapshot(snapshot),
  serializeNameSourceSnapshot(snapshot),
  "cache serialization has no timestamps or nondeterministic metadata"
);

const permutedCachedSnapshot = structuredClone(snapshot);
const cachedEnglish = permutedCachedSnapshot.kornblume.namesByLang["en-US"];
const cachedKeys = Object.keys(cachedEnglish);
const cachedValues = cachedKeys.map((key) => cachedEnglish[key]);
for (const [index, key] of cachedKeys.entries()) {
  cachedEnglish[key] = cachedValues[(index + 1) % cachedValues.length];
}
assert.throws(
  () => validateNameSourceSnapshot(permutedCachedSnapshot),
  /cached Kornblume cross-source coverage failed/,
  "cached validation rechecks slug-to-metadata alignment"
);
console.log("ok: cached Kornblume alignment rejects permuted English values");

const directory = await mkdtemp(path.join(os.tmpdir(), "r1999-name-cache-"));
const cacheFile = path.join(directory, "name-source-cache.json");
try {
  await installNameSourceCache(snapshot, cacheFile);
  assert.deepEqual(await loadNameSourceCache(cacheFile), snapshot);
  const firstBytes = await readFile(cacheFile);
  assert.ok(firstBytes.length > 0, "successful install creates a usable LKG cache");

  const nextSnapshot = structuredClone(snapshot);
  nextSnapshot.kornblume.namesByLang["zh-CN"]["english-0"] = "updated name";
  await installNameSourceCache(nextSnapshot, cacheFile);
  const installedBytes = await readFile(cacheFile);
  assert.notDeepEqual(installedBytes, firstBytes, "a complete valid generation replaces LKG");

  let partialInstallInvoked = false;
  const fallbackWarnings: string[] = [];
  const fallbackResult = await runNameSync({
    refreshSources: async () => {
      const partialFandom = normalizeFandomKoreanSource(fandomRows, 1);
      partialInstallInvoked = true;
      const partialCandidate = structuredClone(nextSnapshot);
      partialCandidate.fandomKr = partialFandom;
      await installNameSourceCache(partialCandidate, cacheFile);
      return partialCandidate;
    },
    loadCachedSources: () => loadNameSourceCache(cacheFile),
    cacheExists: () => existsSync(cacheFile),
    loadCharacters: () => [],
    loadArcanists: () => [],
    loadLocalizedOverrides: () => [],
    writeCharacters: () => {},
    warn: (message) => fallbackWarnings.push(message),
  });
  assert.equal(fallbackResult.sourceMode, "last-known-good");
  assert.equal(
    partialInstallInvoked,
    false,
    "single Fandom failure aborts before cache install is invoked"
  );
  assert.match(fallbackWarnings[0] ?? "", /transport\/Fandom Korean/);
  assert.deepEqual(
    await readFile(cacheFile),
    installedBytes,
    "single Fandom failure selects LKG without changing target bytes"
  );
  assert.deepEqual(
    await loadNameSourceCache(cacheFile),
    nextSnapshot,
    "selected LKG remains the validated previous snapshot"
  );
  console.log("ok: one Fandom acquisition failure preserves and selects LKG before install");

  const truncatedSnapshot = structuredClone(nextSnapshot);
  truncatedSnapshot.wikiRuJa = {};
  await assert.rejects(
    () => installNameSourceCache(truncatedSnapshot, cacheFile),
    (error) => error instanceof NameSourceError && error.kind === "validation"
  );
  assert.deepEqual(
    await readFile(cacheFile),
    installedBytes,
    "truncated candidate is rejected before touching last-known-good bytes"
  );

  const oldTransactionBytes = Buffer.from("old-cache-bytes");
  const newTransactionBytes = Buffer.from("new-cache-bytes");
  const prepareTransaction = async (name: string) => {
    const target = path.join(directory, `${name}-target.json`);
    const staging = path.join(directory, `${name}-staging.json`);
    await writeFile(target, oldTransactionBytes);
    await writeFile(staging, newTransactionBytes);
    return { target, staging };
  };

  const committedCleanup = await prepareTransaction("committed-cleanup");
  let committedBackup = "";
  const committedResult = await replaceFileWithRollback(
    committedCleanup.staging,
    committedCleanup.target,
    {
      exists: existsSync,
      rename: async (from, to) => {
        if (from === committedCleanup.target) committedBackup = to;
        await rename(from, to);
      },
      remove: async (file) => {
        if (file === committedBackup) throw new Error("injected backup cleanup failure");
        await rm(file, { force: true });
      },
    }
  );
  assert.equal(committedResult.committed, true);
  assert.equal(committedResult.backupPath, committedBackup);
  assert.deepEqual(
    await readFile(committedCleanup.target),
    newTransactionBytes,
    "backup cleanup failure is non-fatal after staging commit"
  );
  assert.deepEqual(
    await readFile(committedBackup),
    oldTransactionBytes,
    "non-fatal cleanup leaves an explicit recovery backup"
  );
  await rm(committedBackup, { force: true });
  console.log("ok: post-commit backup cleanup failure is non-fatal and recoverable");

  const failedCommit = await prepareTransaction("failed-commit");
  await assert.rejects(
    () =>
      replaceFileWithRollback(failedCommit.staging, failedCommit.target, {
        exists: existsSync,
        rename: async (from, to) => {
          if (from === failedCommit.staging && to === failedCommit.target) {
            throw new Error("injected staging commit failure");
          }
          await rename(from, to);
        },
        remove: (file) => rm(file, { force: true }),
      }),
    (error) =>
      error instanceof NameSourceError &&
      error.kind === "cache" &&
      error.recoveryPath === undefined &&
      error.cause instanceof Error &&
      error.cause.message === "injected staging commit failure"
  );
  assert.deepEqual(
    await readFile(failedCommit.target),
    oldTransactionBytes,
    "failed commit restores exact previous cache bytes"
  );
  assert.equal(existsSync(failedCommit.staging), false);
  console.log("ok: failed cache commit restores last-known-good bytes");

  console.log("ok: atomic cache install and rollback preserve last-known-good bytes");
} finally {
  await rm(directory, { recursive: true, force: true });
}
