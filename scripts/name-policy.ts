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

export type LocalizedNameOverride = { nameEng: string } & Partial<
  Record<NameLang, string>
>;

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
  unmatchedLocalizedOverrides: string[];
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

function assertUniquePolicyInputs(
  arcanists: readonly ArcanistMapEntry[],
  overrides: readonly LocalizedNameOverride[]
): void {
  const baseIds = new Set<number>();
  for (const entry of arcanists) {
    if (baseIds.has(entry.id)) {
      throw new NamePolicyError(`duplicate ArcanistMap base ID ${entry.id}`);
    }
    baseIds.add(entry.id);
  }
  const overrideNames = new Set<string>();
  for (const override of overrides) {
    if (overrideNames.has(override.nameEng)) {
      throw new NamePolicyError(`duplicate localized override ${override.nameEng}`);
    }
    overrideNames.add(override.nameEng);
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
  localizedOverrides: readonly LocalizedNameOverride[];
}): NamePolicyResult {
  assertUniquePolicyInputs(input.arcanists, input.localizedOverrides);
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
  const diagnostics: NamePolicyDiagnostic[] = [];
  let namesApplied = 0;
  let rarityApplied = 0;

  for (const character of characters) {
    const mapEntry = arcanistByBase.get(character.baseId);
    if (!mapEntry) {
      diagnostics.push({
        characterId: character.id,
        kind: "missing-arcanist",
        detail: `baseId ${character.baseId} not in ArcanistMap`,
      });
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

    const names: Partial<Record<NameLang, string>> = {};
    for (const lang of NAME_LANGS) {
      const name = namesByLang[lang][slug];
      if (name) names[lang] = name;
    }
    if (!names["en-US"] && character.names?.["en-US"]) {
      names["en-US"] = character.names["en-US"];
    }
    if (Object.keys(names).length > 0) {
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

  const characterByEnglishName = new Map(
    characters.map((character) => [character.names?.["en-US"] ?? character.name, character])
  );
  let localizedOverrideFieldsApplied = 0;
  const unmatchedLocalizedOverrides: string[] = [];
  for (const override of input.localizedOverrides) {
    const character = characterByEnglishName.get(override.nameEng);
    if (!character) {
      unmatchedLocalizedOverrides.push(override.nameEng);
      continue;
    }
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
  let englishFallback = 0;
  let englishMissing = 0;
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
    else if (fallbackName || existingName) englishFallback++;
    else englishMissing++;
  }

  const ordered = recalculateReleaseOrder(characters);
  for (const character of ordered) delete character._kbId;
  const missingByLang = Object.fromEntries(
    NAME_LANGS.map((lang) => [
      lang,
      ordered.filter((character) => !character.names?.[lang]).length,
    ])
  ) as Record<NameLang, number>;

  return {
    characters: ordered,
    diagnostics,
    unmatchedLocalizedOverrides,
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
