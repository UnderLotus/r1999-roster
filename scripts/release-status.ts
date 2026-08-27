import { execFileSync } from "node:child_process";

import type { Character } from "./types";

export const GLOBAL_CHARACTER_URL =
  "https://raw.githubusercontent.com/St-Pavlov-Foundation/re1999-data-global/main/data/json/character.json";
export const GLOBAL_SKIN_URL =
  "https://raw.githubusercontent.com/St-Pavlov-Foundation/re1999-data-global/main/data/json/skin.json";

export interface GlobalCharacterRelease {
  id: number;
  isOnline?: string | number | null;
}

export interface GlobalSkinRelease {
  id: number;
}

export interface GlobalReleaseSnapshot {
  characters: GlobalCharacterRelease[];
  skins: GlobalSkinRelease[];
}

export interface CharacterReleaseOverride {
  baseId: number;
  isReleased: boolean;
  note?: string;
}

export interface SkinReleaseOverride {
  variantId: string;
  isReleased: boolean;
  note?: string;
}

export interface ReleaseOverrides {
  characters: CharacterReleaseOverride[];
  skins: SkinReleaseOverride[];
}

export interface ReleaseSyncSummary {
  characterChanges: number;
  skinChanges: number;
  releasedCharacters: number;
  unreleasedCharacters: number;
  releasedSkins: number;
  unreleasedSkins: number;
}

function fetchJSON(url: string): unknown {
  const text = execFileSync(
    "curl",
    ["-fsSL", "-m", "180", "--retry", "2", url],
    { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 }
  );
  return JSON.parse(text) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReleaseOverrides(value: unknown): ReleaseOverrides {
  if (!isRecord(value) || !Array.isArray(value.characters) || !Array.isArray(value.skins)) {
    throw new Error("released-overrides.json must contain characters[] and skins[]");
  }

  const characters = value.characters.map((entry, index): CharacterReleaseOverride => {
    if (
      !isRecord(entry) ||
      !Number.isInteger(entry.baseId) ||
      typeof entry.isReleased !== "boolean" ||
      (entry.note !== undefined && typeof entry.note !== "string")
    ) {
      throw new Error(`Invalid character override at index ${index}`);
    }
    return {
      baseId: entry.baseId as number,
      isReleased: entry.isReleased,
      ...(entry.note === undefined ? {} : { note: entry.note as string }),
    };
  });

  const skins = value.skins.map((entry, index): SkinReleaseOverride => {
    if (
      !isRecord(entry) ||
      typeof entry.variantId !== "string" ||
      !/^\d+$/.test(entry.variantId) ||
      typeof entry.isReleased !== "boolean" ||
      (entry.note !== undefined && typeof entry.note !== "string")
    ) {
      throw new Error(`Invalid skin override at index ${index}`);
    }
    return {
      variantId: entry.variantId,
      isReleased: entry.isReleased,
      ...(entry.note === undefined ? {} : { note: entry.note as string }),
    };
  });

  return { characters, skins };
}

export function parseGlobalCharacters(value: unknown): GlobalCharacterRelease[] {
  if (!Array.isArray(value)) throw new Error("Global character.json is not an array");
  return value.map((entry, index) => {
    if (
      !isRecord(entry) ||
      !Number.isInteger(entry.id) ||
      (entry.isOnline !== undefined &&
        entry.isOnline !== null &&
        typeof entry.isOnline !== "string" &&
        typeof entry.isOnline !== "number")
    ) {
      throw new Error(`Invalid Global character entry at index ${index}`);
    }
    return {
      id: entry.id as number,
      isOnline: entry.isOnline as string | number | null | undefined,
    };
  });
}

function parseGlobalSkins(value: unknown): GlobalSkinRelease[] {
  if (!Array.isArray(value)) throw new Error("Global skin.json is not an array");
  return value.map((entry, index) => {
    if (!isRecord(entry) || !Number.isInteger(entry.id)) {
      throw new Error(`Invalid Global skin entry at index ${index}`);
    }
    return { id: entry.id as number };
  });
}

const GLOBAL_IS_ONLINE_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** Roster tracks the English Global release region's server-local timestamps. */
const GLOBAL_SERVER_UTC_OFFSET_MINUTES = -5 * 60;

function parseGlobalTimestamp(value: string): number | null {
  const match = GLOBAL_IS_ONLINE_TIMESTAMP.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);

  // Validate the server-local wall clock without depending on the machine timezone,
  // then convert it to UTC using the explicitly selected Global region offset.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw new Error(`Invalid Global character.isOnline timestamp: ${value}`);
  }

  return date.getTime() - GLOBAL_SERVER_UTC_OFFSET_MINUTES * 60_000;
}

/**
 * Resolve the Global client isOnline contract.
 *
 * Numeric/string 1 is immediately online; 0, empty and missing are offline.
 * Other valid values are strict YYYY-MM-DD HH:mm:ss server-local timestamps.
 * A timestamp is online only when strictly earlier than the supplied clock.
 */
export function resolveGlobalIsOnline(
  value: unknown,
  clock: Date = new Date()
): boolean {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "0" ||
    value === 0
  ) {
    return false;
  }
  if (value === "1" || value === 1) return true;
  if (typeof value !== "string") {
    throw new Error(`Unsupported Global character.isOnline value: ${String(value)}`);
  }

  const timestamp = parseGlobalTimestamp(value);
  if (timestamp === null) {
    throw new Error(`Unsupported Global character.isOnline value: ${value}`);
  }
  return timestamp < clock.getTime();
}

export function fetchGlobalReleaseSnapshot(): GlobalReleaseSnapshot {
  // Fetch and validate both datasets before callers mutate local data.
  const characters = parseGlobalCharacters(fetchJSON(GLOBAL_CHARACTER_URL));
  const skins = parseGlobalSkins(fetchJSON(GLOBAL_SKIN_URL));
  return { characters, skins };
}

function uniqueMap<T, K>(
  values: readonly T[],
  keyFor: (value: T) => K,
  label: string
): Map<K, T> {
  const result = new Map<K, T>();
  for (const value of values) {
    const key = keyFor(value);
    if (result.has(key)) throw new Error(`Duplicate ${label}: ${String(key)}`);
    result.set(key, value);
  }
  return result;
}

export function applyReleaseStatuses(
  characters: Character[],
  snapshot: GlobalReleaseSnapshot,
  overrides: ReleaseOverrides
): ReleaseSyncSummary {
  const globalCharacters = uniqueMap(snapshot.characters, (entry) => entry.id, "Global character id");
  const globalSkinIds = new Set(snapshot.skins.map((entry) => String(entry.id)));
  if (globalSkinIds.size !== snapshot.skins.length) {
    throw new Error("Global skin.json contains duplicate ids");
  }

  const characterOverrides = uniqueMap(overrides.characters, (entry) => entry.baseId, "character override baseId");
  const skinOverrides = uniqueMap(overrides.skins, (entry) => entry.variantId, "skin override variantId");
  const localBaseIds = new Set(characters.map((character) => character.baseId));
  const localSkinIds = new Set(
    characters.flatMap((character) =>
      character.skins.filter((skin) => skin.type === "skin").map((skin) => skin.variantId)
    )
  );

  for (const baseId of characterOverrides.keys()) {
    if (!localBaseIds.has(baseId)) throw new Error(`Character override does not match local baseId: ${baseId}`);
  }
  for (const variantId of skinOverrides.keys()) {
    if (!localSkinIds.has(variantId)) throw new Error(`Skin override does not match local variantId: ${variantId}`);
  }

  let characterChanges = 0;
  let skinChanges = 0;
  let releasedCharacters = 0;
  let unreleasedCharacters = 0;
  let releasedSkins = 0;
  let unreleasedSkins = 0;
  const releaseClock = new Date();

  for (const character of characters) {
    const global = globalCharacters.get(character.baseId);
    const nextCharacter =
      characterOverrides.get(character.baseId)?.isReleased ??
      resolveGlobalIsOnline(global?.isOnline, releaseClock);
    if (character.isReleased !== nextCharacter) characterChanges++;
    character.isReleased = nextCharacter;
    if (nextCharacter) releasedCharacters++;
    else unreleasedCharacters++;

    for (const skin of character.skins) {
      if (skin.type !== "skin") {
        delete skin.isReleased;
        continue;
      }
      const currentSkin = skin.isReleased !== false;
      const nextSkin =
        skinOverrides.get(skin.variantId)?.isReleased ?? globalSkinIds.has(skin.variantId);
      if (currentSkin !== nextSkin) skinChanges++;
      // Preserve the existing compact contract: missing means released; only false is persisted.
      if (nextSkin) delete skin.isReleased;
      else skin.isReleased = false;
      if (nextSkin) releasedSkins++;
      else unreleasedSkins++;
    }
  }

  return {
    characterChanges,
    skinChanges,
    releasedCharacters,
    unreleasedCharacters,
    releasedSkins,
    unreleasedSkins,
  };
}
