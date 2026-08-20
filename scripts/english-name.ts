/**
 * Resolve Global English display names without reaching the network.
 *
 * Global character.json stores a localization key in `name`; `nameEng` is
 * internal metadata and is intentionally not used as the display name.
 */
export interface GlobalCharacterEntry {
  id: number;
  name?: string;
  /** Internal metadata; never used for the display-name mapping. */
  nameEng?: string;
}

export interface GlobalLocalizationEntry {
  key: string;
  content?: string;
}

const UNITY_RICH_TEXT_TAG =
  /<\/?(?:b|i|u|s|mark|color|size|font|material|align|alpha|cspace|mspace|line-height|line-indent|margin|indent|voffset|nobr)(?:\s*=\s*[^>]*)?>/gi;

/** Remove only known Unity rich-text tags, preserving ordinary angle brackets. */
export function normalizeGlobalEnglishName(value: string | undefined): string | undefined {
  const name = value?.replace(UNITY_RICH_TEXT_TAG, "").trim();
  return name || undefined;
}

/** Build base ID → localized English display-name values from Global unpack data. */
export function buildGlobalEnglishNames(
  characters: readonly GlobalCharacterEntry[],
  localizations: readonly GlobalLocalizationEntry[]
): Map<number, string> {
  const contentByKey = new Map<string, string | undefined>();
  for (const localization of localizations) {
    const key = localization.key.trim();
    if (key) contentByKey.set(key, localization.content);
  }

  const names = new Map<number, string>();
  for (const character of characters) {
    const key = character.name?.trim();
    if (!Number.isInteger(character.id) || !key) continue;
    const name = normalizeGlobalEnglishName(contentByKey.get(key));
    if (name) names.set(character.id, name);
  }
  return names;
}

export type EnglishNameSource = "global" | "fallback" | "existing" | "missing";

export interface EnglishNameResolution {
  name?: string;
  source: EnglishNameSource;
}

function nonEmptyName(value: string | undefined): string | undefined {
  const name = value?.trim();
  return name || undefined;
}

export function resolveEnglishName(
  globalNames: ReadonlyMap<number, string>,
  baseId: number,
  fallbackName: string | undefined,
  existingName: string | undefined
): EnglishNameResolution {
  const globalName = nonEmptyName(globalNames.get(baseId));
  if (globalName) return { name: globalName, source: "global" };

  const fallback = nonEmptyName(fallbackName);
  if (fallback) return { name: fallback, source: "fallback" };

  const existing = nonEmptyName(existingName);
  if (existing) return { name: existing, source: "existing" };

  return { source: "missing" };
}
