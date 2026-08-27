/**
 * Live name update entry point.
 *
 * Source transport/normalization lives in fetch-name-sources.ts, deterministic
 * matching and precedence in name-policy.ts, and this file orchestrates I/O.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { refreshNameSourceCache } from "./fetch-name-sources";
import {
  loadNameSourceCache,
  NAME_SOURCE_CACHE_FILE,
} from "./name-source-cache";
import {
  applyNamePolicy,
  type ArcanistMapEntry,
  type LocalizedNameOverride,
  type NamePolicyResult,
} from "./name-policy";
import { NameSourceError, type NameSourceSnapshot } from "./name-source";
import type { Character } from "./types";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, "..");
const charactersFile = path.join(root, "src/data/characters.json");
const arcanistMapFile = path.join(scriptDirectory, "data/ArcanistMap.json");
const japaneseOverridesFile = path.join(
  scriptDirectory,
  "data/jp-name-overrides.json"
);
const localizedOverridesFile = path.join(
  scriptDirectory,
  "data/localized-name-overrides.json"
);

export interface NameSyncDependencies {
  refreshSources(): Promise<NameSourceSnapshot>;
  loadCachedSources(): Promise<NameSourceSnapshot>;
  cacheExists(): boolean;
  loadCharacters(): Character[];
  loadArcanists(): ArcanistMapEntry[];
  loadLocalizedOverrides(): LocalizedNameOverride[];
  writeCharacters(characters: Character[]): void;
  warn(message: string): void;
}

export interface NameSyncResult extends NamePolicyResult {
  sourceMode: "refreshed" | "last-known-good";
}

/** Acquire one validated snapshot, apply the deterministic policy, and write. */
export async function runNameSync(
  dependencies: NameSyncDependencies
): Promise<NameSyncResult> {
  let snapshot: NameSourceSnapshot;
  let sourceMode: NameSyncResult["sourceMode"] = "refreshed";
  try {
    snapshot = await dependencies.refreshSources();
  } catch (error) {
    if (
      !(error instanceof NameSourceError) ||
      !error.recoverableWithLkg ||
      !dependencies.cacheExists()
    ) {
      throw error;
    }
    dependencies.warn(
      `name source refresh failed [${error.kind}/${error.source}]; using last-known-good cache: ${error.message}`
    );
    snapshot = await dependencies.loadCachedSources();
    sourceMode = "last-known-good";
  }

  const result = applyNamePolicy({
    characters: dependencies.loadCharacters(),
    arcanists: dependencies.loadArcanists(),
    snapshot,
    localizedOverrides: dependencies.loadLocalizedOverrides(),
  });
  dependencies.writeCharacters(result.characters);
  return { ...result, sourceMode };
}

function loadJson<Value>(file: string): Value {
  return JSON.parse(readFileSync(file, "utf8")) as Value;
}

async function main(): Promise<void> {
  console.log("build:names — normalized sources → deterministic name policy\n");
  const result = await runNameSync({
    refreshSources: () =>
      refreshNameSourceCache({
        japaneseOverridesFile,
        cacheFile: NAME_SOURCE_CACHE_FILE,
      }),
    loadCachedSources: () => loadNameSourceCache(NAME_SOURCE_CACHE_FILE),
    cacheExists: () => existsSync(NAME_SOURCE_CACHE_FILE),
    loadCharacters: () => loadJson<Character[]>(charactersFile),
    loadArcanists: () => loadJson<ArcanistMapEntry[]>(arcanistMapFile),
    loadLocalizedOverrides: () =>
      loadJson<LocalizedNameOverride[]>(localizedOverridesFile),
    writeCharacters: (characters) =>
      writeFileSync(
        charactersFile,
        JSON.stringify(characters, null, 2) + "\n",
        "utf8"
      ),
    warn: (message) => console.warn(`⚠ ${message}`),
  });

  const { summary } = result;
  console.log(`source snapshot: ${result.sourceMode}`);
  console.log(
    `localized overrides: ${summary.localizedOverrideFieldsApplied} fields`
  );
  console.log(
    `Global localized override: ${summary.globalCharacters}/${result.characters.length} characters, ${summary.globalFieldsApplied} fields`
  );
  console.log(
    `en-US: global ${summary.globalEnglishApplied}/${result.characters.length}; ` +
      `fallback/existing ${summary.englishFallback}; missing ${summary.englishMissing}`
  );
  console.log("releaseOrder recalculated");
  console.log("\n=== summary ===");
  console.log(`names: ${summary.namesApplied}/${result.characters.length}`);
  console.log(`rarity: ${summary.rarityApplied}/${result.characters.length}`);
  if (result.diagnostics.length > 0) {
    console.warn(`⚠ unmatched ${result.diagnostics.length} characters:`);
    for (const diagnostic of result.diagnostics.slice(0, 10)) {
      console.warn(`  ${diagnostic.characterId}: ${diagnostic.detail}`);
    }
    if (result.diagnostics.length > 10) {
      console.warn(`  ... +${result.diagnostics.length - 10}`);
    }
  }
  if (result.unmatchedLocalizedOverrides.length > 0) {
    console.warn(
      `⚠ unmatched localized overrides: ${result.unmatchedLocalizedOverrides.join(
        ", "
      )}`
    );
  }
  console.log("missing names:", JSON.stringify(summary.missingByLang));
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return (
    Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href
  );
}

if (isMainModule()) {
  void main().catch((error) => {
    console.error("failed:", error);
    process.exitCode = 1;
  });
}
