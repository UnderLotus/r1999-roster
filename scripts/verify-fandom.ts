/*
 * verify:fandom — read-only consistency check between GL skin data and Fandom Garments.
 *
 * This command never mutates characters.json or release overrides.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchGlobalReleaseSnapshot } from "./release-status";
import type { Character } from "./types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "src/data/characters.json");
const ALIASES_FILE = path.join(__dirname, "data/skin-aliases.json");
const FANDOM_API = "https://reverse1999.fandom.com/api.php";

interface GarmentBox {
  char: string;
  skin: string;
}

interface SkinMismatch {
  variantId: string;
  character: string;
  skin: string;
}

function fetchText(url: string): string {
  return execFileSync("curl", ["-fsSL", "-m", "60", url], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function fetchFandomGarments(): GarmentBox[] {
  const url = `${FANDOM_API}?action=parse&page=Garments&prop=wikitext&format=json`;
  const json = JSON.parse(fetchText(url)) as {
    parse?: { wikitext?: { "*"?: string } };
  };
  const wikitext = json.parse?.wikitext?.["*"] ?? "";
  const boxes: GarmentBox[] = [];
  const pattern = /\{\{GarmentBox\|([^|}]+)\|([^|}]+)\|\d+\|\d+\|([^}|]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(wikitext)) !== null) {
    boxes.push({ char: match[1]!.trim(), skin: match[2]!.trim() });
  }
  if (boxes.length === 0) throw new Error("Fandom Garments parser returned no entries");
  return boxes;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "of", "in", "on", "at", "to", "from", "and", "for",
  "with", "by", "over", "under", "into", "behind", "through", "across",
  "around", "against", "as", "is", "are", "me", "my",
]);

function normalizeName(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/'s\b/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word && !STOP_WORDS.has(word) && !/^\d+$/.test(word));
  return [...new Set(words)].sort().join(" ");
}

function main(): void {
  console.log("verify:fandom — read-only GL/Fandom skin consistency check\n");

  const characters = JSON.parse(readFileSync(DATA_FILE, "utf-8")) as Character[];
  const aliases = existsSync(ALIASES_FILE)
    ? (JSON.parse(readFileSync(ALIASES_FILE, "utf-8")) as Record<string, string>)
    : {};
  const snapshot = fetchGlobalReleaseSnapshot();
  const globalSkinIds = new Set(snapshot.skins.map((skin) => String(skin.id)));
  const garments = fetchFandomGarments();

  const characterKeys = new Map<string, Character>();
  for (const character of characters) {
    const english = character.names?.["en-US"];
    if (english) characterKeys.set(english.toLowerCase(), character);
    characterKeys.set(character.name.toLowerCase(), character);
  }

  const findCharacter = (name: string): Character | undefined => {
    const key = name.toLowerCase();
    const exact = characterKeys.get(key);
    if (exact) return exact;
    for (const [candidate, character] of characterKeys) {
      if (candidate.length > 3 && (candidate.includes(key) || key.includes(candidate))) {
        return character;
      }
    }
    return undefined;
  };

  const fandomByBaseId = new Map<number, Set<string>>();
  const unmatchedCharacters = new Set<string>();
  for (const garment of garments) {
    const character = findCharacter(garment.char);
    if (!character) {
      unmatchedCharacters.add(garment.char);
      continue;
    }
    const names = fandomByBaseId.get(character.baseId) ?? new Set<string>();
    names.add(normalizeName(garment.skin));
    fandomByBaseId.set(character.baseId, names);
  }

  const globalOnly: SkinMismatch[] = [];
  const fandomOnly: SkinMismatch[] = [];
  for (const character of characters) {
    const fandomNames = fandomByBaseId.get(character.baseId) ?? new Set<string>();
    for (const skin of character.skins) {
      if (skin.type !== "skin") continue;
      const candidates = [skin.skinNameEng, aliases[skin.variantId]]
        .filter((name): name is string => Boolean(name))
        .map(normalizeName);
      const fandomHas = candidates.some((name) => fandomNames.has(name));
      const globalHas = globalSkinIds.has(skin.variantId);
      if (globalHas === fandomHas) continue;
      const mismatch = {
        variantId: skin.variantId,
        character: character.names?.["en-US"] ?? character.name,
        skin: skin.skinNameEng ?? skin.skinName ?? "?",
      };
      if (globalHas) globalOnly.push(mismatch);
      else fandomOnly.push(mismatch);
    }
  }

  const printGroup = (title: string, values: SkinMismatch[]): void => {
    console.log(`\n${title} (${values.length})`);
    for (const value of values) {
      console.log(`  ${value.variantId} ${value.character} — ${value.skin}`);
    }
    if (values.length === 0) console.log("  (none)");
  };

  console.log(`Fandom Garments: ${garments.length}; Global skins: ${snapshot.skins.length}`);
  printGroup("GL present / Fandom missing", globalOnly);
  printGroup("Fandom present / GL missing", fandomOnly);
  if (unmatchedCharacters.size > 0) {
    console.log(`\nUnmatched Fandom character names (${unmatchedCharacters.size})`);
    console.log(`  ${[...unmatchedCharacters].sort().join(", ")}`);
  }
  console.log("\nVerification only: no files were changed.");
}

try {
  main();
} catch (error) {
  console.error("verify:fandom failed:", error);
  process.exitCode = 1;
}
