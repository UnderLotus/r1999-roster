import { recalculateReleaseOrder } from "./recalculate-order";
import {
  NAME_LANGS,
  slugifyName,
  type NameLang,
  type NameSourceSnapshot,
} from "./name-source";
import type { Character } from "./types";

export interface ArcanistMapEntry {
  id: number;
  name: string;
  nameEng: string;
}

export type LocalizedNameOverride = { baseId: number } & Partial<
  Record<NameLang, string>
>;

/** Validated UTTU fallback names for a character absent from the CN mapping. */
export interface SupplementNameMetadata {
  baseId: number;
  names: Partial<Record<NameLang, string>>;
  rarity?: number;
}

/** Live UTTU profile names: name-only fallback, never admission or rarity. */
export type UttuNameFallback = Pick<SupplementNameMetadata, "baseId" | "names">;

export interface NamePolicyDiagnostic {
  characterId: string;
  kind: "missing-arcanist" | "missing-kornblume-name" | "missing-kornblume-metadata";
  detail: string;
}

export interface NamePolicySummary {
  namesApplied: number;
  rarityApplied: number;
  localizedOverrideFieldsApplied: number;
  globalFieldsApplied: number;
  globalCharacters: number;
  globalEnglishApplied: number;
  englishFallback: number;
  englishMissing: number;
  missingByLang: Record<NameLang, number>;
}

export interface NamePolicyResult {
  characters: Character[];
  diagnostics: NamePolicyDiagnostic[];
  summary: NamePolicySummary;
}

export class NamePolicyError extends Error {
  readonly kind = "policy" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NamePolicyError";
  }
}

function cloneCharacters(characters: readonly Character[]): Character[] {
  return characters.map((character) => ({
    ...character,
    names: character.names ? { ...character.names } : undefined,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate the raw JSON trust seam once, before any name is written. */
function parseLocalizedOverrides(
  raw: unknown,
  characters: readonly Character[]
): Map<number, LocalizedNameOverride> {
  if (!Array.isArray(raw)) {
    throw new NamePolicyError("localized overrides must be an array");
  }
  const knownBaseIds = new Set(characters.map((character) => character.baseId));
  const overrides = new Map<number, LocalizedNameOverride>();

  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      throw new NamePolicyError(`invalid localized override at index ${index}`);
    }
    const baseId = entry.baseId;
    if (!Number.isSafeInteger(baseId) || (baseId as number) <= 0) {
      throw new NamePolicyError(`invalid localized override Base ID at index ${index}`);
    }
    const id = baseId as number;
    if (!knownBaseIds.has(id)) {
      throw new NamePolicyError(`localized override Base ID ${id} not found in characters`);
    }
    if (overrides.has(id)) {
      throw new NamePolicyError(`duplicate localized override Base ID ${id}`);
    }

    const override: LocalizedNameOverride = { baseId: id };
    let localeFields = 0;
    for (const [field, name] of Object.entries(entry)) {
      if (field === "baseId") continue;
      if (!NAME_LANGS.includes(field as NameLang)) {
        throw new NamePolicyError(
          `unsupported localized override field ${JSON.stringify(field)} for Base ID ${id}`
        );
      }
      if (typeof name !== "string" || !name.trim()) {
        throw new NamePolicyError(
          `localized override ${field} for Base ID ${id} must be a nonempty string`
        );
      }
      override[field as NameLang] = name;
      localeFields++;
    }
    if (localeFields === 0) {
      throw new NamePolicyError(`localized override Base ID ${id} has no locale names`);
    }
    overrides.set(id, override);
  }
  return overrides;
}

function assertUniqueArcanistBaseIds(
  arcanists: readonly ArcanistMapEntry[]
): void {
  const baseIds = new Set<number>();
  for (const entry of arcanists) {
    if (baseIds.has(entry.id)) {
      throw new NamePolicyError(`duplicate ArcanistMap base ID ${entry.id}`);
    }
    baseIds.add(entry.id);
  }
}

function mergedKornblumeNames(
  snapshot: NameSourceSnapshot
): Record<NameLang, Record<string, string>> {
  const names = Object.fromEntries(
    NAME_LANGS.map((lang) => [lang, { ...snapshot.kornblume.namesByLang[lang] }])
  ) as Record<NameLang, Record<string, string>>;
  for (const [slug, name] of Object.entries(snapshot.wikiRuJa)) {
    if (!names["ja-JP"][slug]) names["ja-JP"][slug] = name;
  }
  for (const [slug, name] of Object.entries(snapshot.fandomKr)) {
    if (!names["ko-KR"][slug]) names["ko-KR"][slug] = name;
  }
  return names;
}

function applyArcanistBaseline(
  character: Character,
  entry: ArcanistMapEntry
): void {
  character.names ??= {};
  if (!character.names["zh-CN"]) character.names["zh-CN"] = entry.name;
  if (!character.names["en-US"]) character.names["en-US"] = entry.nameEng;
}

/** Apply all name/matching precedence from normalized snapshots, without I/O. */
export function applyNamePolicy(input: {
  characters: readonly Character[];
  arcanists: readonly ArcanistMapEntry[];
  snapshot: NameSourceSnapshot;
  localizedOverrides: unknown;
  supplementMetadata?: readonly SupplementNameMetadata[];
  uttuNames?: readonly UttuNameFallback[];
}): NamePolicyResult {
  const localizedOverrides = parseLocalizedOverrides(
    input.localizedOverrides,
    input.characters
  );
  assertUniqueArcanistBaseIds(input.arcanists);
  const characters = cloneCharacters(input.characters);
  const existingEnglishNames = new Map(
    characters.map((character) => [character.id, character.names?.["en-US"]])
  );
  const namesByLang = mergedKornblumeNames(input.snapshot);
  const kornblumeBySlug = new Map(
    input.snapshot.kornblume.arcanists.map((entry) => [slugifyName(entry.name), entry])
  );
  const chineseToSlug = new Map(
    Object.entries(namesByLang["zh-CN"]).map(([slug, name]) => [name, slug])
  );
  const arcanistByBase = new Map(input.arcanists.map((entry) => [entry.id, entry]));
  const supplementByBase = new Map(
    (input.supplementMetadata ?? []).map((entry) => [entry.baseId, entry])
  );
  const diagnostics: NamePolicyDiagnostic[] = [];
  let namesApplied = 0;
  let rarityApplied = 0;

  for (const character of characters) {
    const mapEntry = arcanistByBase.get(character.baseId);
    const supplement = supplementByBase.get(character.baseId);
    if (!mapEntry) {
      if (!supplement) {
        diagnostics.push({
          characterId: character.id,
          kind: "missing-arcanist",
          detail: `baseId ${character.baseId} not in ArcanistMap`,
        });
        continue;
      }
      character.names ??= {};
      const zhName = supplement.names["zh-CN"];
      const enName = supplement.names["en-US"];
      if (!character.names["zh-CN"] && zhName) character.names["zh-CN"] = zhName;
      if (!character.names["en-US"] && enName) character.names["en-US"] = enName;
      if (character.rarity === undefined && supplement.rarity !== undefined) {
        character.rarity = supplement.rarity;
      }
      continue;
    }
    const slug = chineseToSlug.get(mapEntry.name);
    if (!slug) {
      applyArcanistBaseline(character, mapEntry);
      diagnostics.push({
        characterId: character.id,
        kind: "missing-kornblume-name",
        detail: `CN name ${JSON.stringify(mapEntry.name)} not in Kornblume`,
      });
      continue;
    }
    const kornblume = kornblumeBySlug.get(slug);
    if (!kornblume) {
      applyArcanistBaseline(character, mapEntry);
      diagnostics.push({
        characterId: character.id,
        kind: "missing-kornblume-metadata",
        detail: `slug ${JSON.stringify(slug)} not in Kornblume metadata`,
      });
      continue;
    }

    // Seed with persisted names so a language this generation lacks is not erased.
    const names: Partial<Record<NameLang, string>> = { ...character.names };
    let kornblumeNamesApplied = false;
    for (const lang of NAME_LANGS) {
      const name = namesByLang[lang][slug];
      if (!name) continue;
      names[lang] = name;
      kornblumeNamesApplied = true;
    }
    if (kornblumeNamesApplied) {
      character.names = names;
      namesApplied++;
    }
    if (kornblume.rarity) {
      character.rarity = kornblume.rarity;
      character._kbId = kornblume.id;
      rarityApplied++;
    }
    if (character.stage === "pending-names") character.stage = "live";
  }

  let localizedOverrideFieldsApplied = 0;
  for (const character of characters) {
    const override = localizedOverrides.get(character.baseId);
    if (!override) continue;
    character.names ??= {};
    for (const lang of NAME_LANGS) {
      const name = override[lang];
      if (!name) continue;
      character.names[lang] = name;
      localizedOverrideFieldsApplied++;
    }
  }

  let globalFieldsApplied = 0;
  let globalCharacters = 0;
  for (const character of characters) {
    let covered = false;
    for (const lang of NAME_LANGS) {
      if (lang === "en-US") continue;
      const name = input.snapshot.globalNamesByLang[lang][String(character.baseId)];
      if (!name) continue;
      covered = true;
      character.names ??= {};
      if (character.names[lang] !== name) globalFieldsApplied++;
      character.names[lang] = name;
    }
    if (covered) globalCharacters++;
  }

  const globalEnglishNames = new Map(
    Object.entries(input.snapshot.globalNamesByLang["en-US"]).map(([id, name]) => [
      Number(id),
      name,
    ])
  );
  let globalEnglishApplied = 0;
  for (const character of characters) {
    const globalName = globalEnglishNames.get(character.baseId)?.trim() || undefined;
    const fallbackName = character.names?.["en-US"]?.trim() || undefined;
    const existingName = existingEnglishNames.get(character.id)?.trim() || undefined;
    const englishName = globalName ?? fallbackName ?? existingName;
    if (englishName) {
      character.names ??= {};
      character.names["en-US"] = englishName;
    }
    if (globalName) globalEnglishApplied++;
  }

  // UTTU is always the last name fallback: it fills only languages that remain
  // empty after GL, Kornblume, manual overrides and existing local data. Live
  // profiles cover every existing Character; admitted supplements cover the rest.
  const liveUttuByBase = new Map(
    (input.uttuNames ?? []).map((entry) => [entry.baseId, entry])
  );
  for (const character of characters) {
    const live = liveUttuByBase.get(character.baseId);
    const supplement = supplementByBase.get(character.baseId);
    if (live || supplement) {
      character.names ??= {};
      for (const lang of NAME_LANGS) {
        if (character.names[lang]) continue;
        const fallback = live?.names[lang] ?? supplement?.names[lang];
        if (fallback) character.names[lang] = fallback;
      }
    }
    if (character.rarity === undefined && supplement?.rarity !== undefined) {
      character.rarity = supplement.rarity;
    }
  }

  const ordered = recalculateReleaseOrder(characters);
  for (const character of ordered) delete character._kbId;
  const missingByLang = Object.fromEntries(
    NAME_LANGS.map((lang) => [
      lang,
      ordered.filter((character) => !character.names?.[lang]).length,
    ])
  ) as Record<NameLang, number>;
  const englishMissing = missingByLang["en-US"];
  const englishFallback = ordered.length - globalEnglishApplied - englishMissing;

  return {
    characters: ordered,
    diagnostics,
    summary: {
      namesApplied,
      rarityApplied,
      localizedOverrideFieldsApplied,
      globalFieldsApplied,
      globalCharacters,
      globalEnglishApplied,
      englishFallback,
      englishMissing,
      missingByLang,
    },
  };
}
