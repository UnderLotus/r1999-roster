/**
 * Map Global character localization keys to display names without transport.
 *
 * Global character.json stores a localization key in `name`; `nameEng` is
 * internal metadata and is intentionally not used as a display name.
 */
export interface GlobalCharacterEntry {
  id: number;
  name?: string;
  /** Internal metadata; never used for localization mapping. */
  nameEng?: string;
}

export interface GlobalLocalizationEntry {
  key: string;
  content?: string;
}

const UNITY_RICH_TEXT_TAG =
  /<\/?(?:b|i|u|s|mark|color|size|font|material|align|alpha|cspace|mspace|line-height|line-indent|margin|indent|voffset|nobr)(?:\s*=\s*[^>]*)?>/gi;

/** Remove known Unity rich-text tags while preserving ordinary angle brackets. */
export function normalizeGlobalLocalizedName(
  value: string | undefined
): string | undefined {
  const name = value?.replace(UNITY_RICH_TEXT_TAG, "").trim();
  return name || undefined;
}

/** Build Global base ID → localized display name for any language file. */
export function buildGlobalLocalizedNames(
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
    const name = normalizeGlobalLocalizedName(contentByKey.get(key));
    if (name) names.set(character.id, name);
  }
  return names;
}
