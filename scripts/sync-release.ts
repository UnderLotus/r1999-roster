/*
 * sync:release — Global-first character and skin release status sync.
 *
 * Character: manual baseId override > GL character.isOnline > false
 * Skin:      manual variantId override > present in GL skin.json > false
 *
 * GL data is a client-build checkpoint. Manual false overrides gate preload and
 * second-half content until it is actually live.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyReleaseStatuses,
  fetchGlobalReleaseSnapshot,
  parseReleaseOverrides,
} from "./release-status";
import type { Character } from "./types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "src/data/characters.json");
const OVERRIDES_FILE = path.join(__dirname, "data/released-overrides.json");

function main(): void {
  console.log("sync:release — GL-first release status\n");

  const characters = JSON.parse(readFileSync(DATA_FILE, "utf-8")) as Character[];
  const overrides = parseReleaseOverrides(
    JSON.parse(readFileSync(OVERRIDES_FILE, "utf-8")) as unknown
  );

  console.log("→ Fetching and validating Global character.json + skin.json...");
  const snapshot = fetchGlobalReleaseSnapshot();
  console.log(
    `  Global: ${snapshot.characters.length} characters, ${snapshot.skins.length} skins`
  );
  console.log(
    `  Manual: ${overrides.characters.length} characters, ${overrides.skins.length} skins`
  );

  const summary = applyReleaseStatuses(characters, snapshot, overrides);

  const tempFile = `${DATA_FILE}.tmp`;
  writeFileSync(tempFile, JSON.stringify(characters, null, 2) + "\n", "utf-8");
  renameSync(tempFile, DATA_FILE);

  console.log("\n=== Summary ===");
  console.log(
    `Characters: ${summary.releasedCharacters} released, ${summary.unreleasedCharacters} unreleased, ${summary.characterChanges} changed`
  );
  console.log(
    `Skins: ${summary.releasedSkins} released, ${summary.unreleasedSkins} unreleased, ${summary.skinChanges} changed`
  );
  console.log(`✓ Updated: ${DATA_FILE}`);
}

try {
  main();
} catch (error) {
  console.error("sync:release failed:", error);
  process.exitCode = 1;
}
