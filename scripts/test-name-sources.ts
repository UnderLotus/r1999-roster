import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runNameSync } from "./build-names";
import {
  loadJapaneseNameOverrides,
  parseJapaneseNameOverrides,
} from "./fetch-name-sources";
import {
  createNameSourceSnapshot,
  NAME_LANGS,
  NameConfigurationError,
  NameSourceError,
  normalizeFandomKoreanSource,
  parseFandomKoreanName,
  parseGlobalSource,
  parseKornblumeSource,
  parseWikiRuJapaneseSource,
  validateNameSourceSnapshot,
  type NameLang,
  type NameSourceSnapshot,
} from "./name-source";
import {
  installNameSourceCache,
  loadNameSourceCache,
  replaceFileWithRollback,
  serializeNameSourceSnapshot,
} from "./name-source-cache";

async function testJapaneseOverridesConfig(): Promise<void> {
  assert.throws(
    () => parseJapaneseNameOverrides("not-json", "fixture overrides"),
    (error) => error instanceof NameConfigurationError && error.recoverableWithLkg === false
  );
  const dir = await mkdtemp(path.join(os.tmpdir(), "r1999-name-config-"));
  try {
    const malformed = path.join(dir, "malformed.json");
    await writeFile(malformed, "not-json");
    for (const file of [malformed, path.join(dir, "missing.json")]) {
      await assert.rejects(
        () => loadJapaneseNameOverrides(file),
        (error) => error instanceof NameConfigurationError && error.recoverableWithLkg === false
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function buildValidFixtures(): {
  snapshot: NameSourceSnapshot;
  fandomRows: Array<{ englishName: string; wikitext: string }>;
} {
  // 1. Kornblume parser + alignment + duplicate/truncation/parse guards
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
  const kornblume = parseKornblumeSource(rawKornblumeNames, rawKornblumeArcanists);
  assert.equal(kornblume.arcanists.length, 100);
  assert.equal(kornblume.namesByLang["en-US"]["english-2"], "English 2");

  const permutedEnglish = JSON.parse(rawKornblumeNames["en-US"]) as Record<string, string>;
  const keys = Object.keys(permutedEnglish);
  const values = keys.map((key) => permutedEnglish[key]);
  for (const [index, key] of keys.entries()) {
    permutedEnglish[key] = values[(index + 1) % values.length];
  }
  assert.throws(
    () =>
      parseKornblumeSource(
        { ...rawKornblumeNames, "en-US": JSON.stringify(permutedEnglish) },
        rawKornblumeArcanists
      ),
    /cross-source coverage failed/
  );
  assert.throws(
    () => parseKornblumeSource({ ...rawKornblumeNames, "ko-KR": "{}" }, rawKornblumeArcanists),
    (error) => error instanceof NameSourceError && error.kind === "validation"
  );

  const dupIdArcanists = JSON.parse(rawKornblumeArcanists) as Array<{ Id: number; Name: string; Rarity: number }>;
  dupIdArcanists[1].Id = dupIdArcanists[0].Id;
  assert.throws(
    () => parseKornblumeSource(rawKornblumeNames, JSON.stringify(dupIdArcanists)),
    /duplicate arcanist ID/
  );

  const dupSlugArcanists = JSON.parse(rawKornblumeArcanists) as Array<{ Id: number; Name: string; Rarity: number }>;
  dupSlugArcanists[1].Name = dupSlugArcanists[0].Name;
  assert.throws(
    () => parseKornblumeSource(rawKornblumeNames, JSON.stringify(dupSlugArcanists)),
    /duplicate or empty arcanist slug/
  );
  assert.throws(
    () => parseKornblumeSource(rawKornblumeNames, "not-json"),
    (error) => error instanceof NameSourceError && error.kind === "parse"
  );

  // 2. Global source parser + duplicate key + sentinel 3003 guard
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
  const globalNamesByLang = parseGlobalSource(rawGlobalCharacters, rawGlobalLanguages);
  assert.equal(globalNamesByLang["ja-JP"]["3003"], "ja-JP 3003");

  const dupGlobalRows = JSON.parse(rawGlobalLanguages["en-US"]) as Array<{ key: string; content: string }>;
  dupGlobalRows[dupGlobalRows.length - 1].key = dupGlobalRows[0].key;
  assert.throws(
    () =>
      parseGlobalSource(rawGlobalCharacters, {
        ...rawGlobalLanguages,
        "en-US": JSON.stringify(dupGlobalRows),
      }),
    /duplicate localization key/
  );
  assert.throws(
    () =>
      parseGlobalSource(
        JSON.stringify(globalCharacters.filter((entry) => entry.id !== 3003)),
        rawGlobalLanguages
      ),
    (error) => error instanceof NameSourceError && error.kind === "validation"
  );

  // 3. WikiRu Japanese (Latin icon + non-Latin icon bridged via jp-name-overrides) & Fandom Korean
  const nonLatinHex = Buffer.from("img日本語アイコン_icon", "utf8").toString("hex");
  const wikiMarkdown = [
    ...Array.from({ length: 29 }, (_, index) => {
      const encoded = Buffer.from(`imgEnglish ${index}_icon`, "utf8").toString("hex");
      return `[icon](attach2/${encoded}.png) Japanese ${index}](target)`;
    }),
    `[icon](attach2/${nonLatinHex}.png) 特例キャラ](target)`,
  ].join("\n");
  const wikiRuJa = parseWikiRuJapaneseSource(
    wikiMarkdown,
    kornblume.namesByLang["ja-JP"],
    { "特例キャラ": "Special Character" }
  );
  assert.equal(wikiRuJa["english-0"], "Japanese 0");
  assert.equal(
    wikiRuJa["special-character"],
    "特例キャラ",
    "non-Latin WikiRu icon bridges through jp-name-overrides"
  );
  assert.throws(() => parseWikiRuJapaneseSource("truncated", {}, {}), /is truncated/);

  assert.equal(parseFandomKoreanName("{{Character|name_kor=한국어\n|other=1}}"), "한국어");
  assert.equal(parseFandomKoreanName("{{Character|name_kor={{template}}}}"), undefined);
  const fandomRows = Array.from({ length: 30 }, (_, index) => ({
    englishName: `English ${index}`,
    wikitext: `{{Character|name_kor=한국어 ${index}\n|other=value}}`,
  }));
  const fandomKr = normalizeFandomKoreanSource(fandomRows, 0);
  assert.equal(fandomKr["english-0"], "한국어 0");
  assert.deepEqual(
    normalizeFandomKoreanSource([...fandomRows].reverse(), 0),
    fandomKr,
    "Fandom normalization is independent of concurrent fetch completion order"
  );
  assert.throws(
    () => normalizeFandomKoreanSource(fandomRows, 1),
    (error) => error instanceof NameSourceError && error.kind === "transport"
  );

  const snapshot = createNameSourceSnapshot({
    kornblume,
    wikiRuJa,
    fandomKr,
    globalNamesByLang,
  });
  return { snapshot, fandomRows };
}

async function testSnapshotAndAtomicCache(
  snapshot: NameSourceSnapshot,
  fandomRows: Array<{ englishName: string; wikitext: string }>
): Promise<void> {
  // Deterministic serialization & cached cross-source alignment validation
  assert.equal(
    serializeNameSourceSnapshot(snapshot),
    serializeNameSourceSnapshot(snapshot),
    "cache serialization contains no timestamps or nondeterministic metadata"
  );

  const permutedCached = structuredClone(snapshot);
  const cachedEnglish = permutedCached.kornblume.namesByLang["en-US"];
  const keys = Object.keys(cachedEnglish);
  const values = keys.map((key) => cachedEnglish[key]);
  for (const [index, key] of keys.entries()) {
    cachedEnglish[key] = values[(index + 1) % values.length];
  }
  assert.throws(
    () => validateNameSourceSnapshot(permutedCached),
    /cached Kornblume cross-source coverage failed/
  );

  const dir = await mkdtemp(path.join(os.tmpdir(), "r1999-name-cache-"));
  const cacheFile = path.join(dir, "name-source-cache.json");
  try {
    await installNameSourceCache(snapshot, cacheFile);
    assert.deepEqual(await loadNameSourceCache(cacheFile), snapshot);
    const firstBytes = await readFile(cacheFile);

    const nextSnapshot = structuredClone(snapshot);
    nextSnapshot.kornblume.namesByLang["zh-CN"]["english-0"] = "updated name";
    await installNameSourceCache(nextSnapshot, cacheFile);
    const installedBytes = await readFile(cacheFile);
    assert.notDeepEqual(installedBytes, firstBytes);

    // Fandom transport failure aborts before cache install and selects on-disk LKG.
    let partialInstallInvoked = false;
    const warnings: string[] = [];
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
      warn: (message) => warnings.push(message),
    });
    assert.equal(fallbackResult.sourceMode, "last-known-good");
    assert.equal(partialInstallInvoked, false);
    assert.match(warnings[0] ?? "", /transport\/Fandom Korean/);
    assert.deepEqual(await readFile(cacheFile), installedBytes);

    // Truncated candidate is rejected before touching LKG bytes.
    const truncated = structuredClone(nextSnapshot);
    truncated.wikiRuJa = {};
    await assert.rejects(
      () => installNameSourceCache(truncated, cacheFile),
      (error) => error instanceof NameSourceError && error.kind === "validation"
    );
    assert.deepEqual(await readFile(cacheFile), installedBytes);

    // Pre-commit rename failure restores exact previous bytes and removes staging.
    const oldBytes = Buffer.from("old-cache-bytes");
    const newBytes = Buffer.from("new-cache-bytes");
    const target = path.join(dir, "failed-commit-target.json");
    const staging = path.join(dir, "failed-commit-staging.json");
    await writeFile(target, oldBytes);
    await writeFile(staging, newBytes);
    await assert.rejects(
      () =>
        replaceFileWithRollback(staging, target, {
          exists: existsSync,
          rename: async (from, to) => {
            if (from === staging && to === target) {
              throw new Error("injected staging commit failure");
            }
            await rename(from, to);
          },
          remove: (file) => rm(file, { force: true }),
        }),
      (error) =>
        error instanceof NameSourceError &&
        error.kind === "cache" &&
        error.recoveryPath === undefined
    );
    assert.deepEqual(await readFile(target), oldBytes);
    assert.equal(existsSync(staging), false);

  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await testJapaneseOverridesConfig();
const { snapshot, fandomRows } = buildValidFixtures();
await testSnapshotAndAtomicCache(snapshot, fandomRows);

console.log("Name source adapters and atomic cache checks passed.");
