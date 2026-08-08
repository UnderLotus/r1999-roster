/**
 * Shared skin helpers.
 *
 * Used by: build-characters.ts, sync-assets.ts
 */

import type { Character } from "./types";

export function skinTypeFromId(variantId: number): Character["skins"][number]["type"] {
  const suffix = variantId % 100;
  if (suffix === 1) return "default";
  if (suffix === 2) return "insight";
  return "skin";
}

export interface ArcanistSkinFull {
  id: number;
  characterSkin: string;
  characterSkinNameEng: string;
}

export interface ArcanistEntryFull {
  id: number;
  name: string;
  nameEng: string;
  live2d: ArcanistSkinFull[];
}

export function buildSkins(entry: ArcanistEntryFull): Character["skins"] {
  return entry.live2d.map((s) => ({
    variantId: String(s.id),
    type: skinTypeFromId(s.id),
    skinName: s.characterSkin || null,
    skinNameEng: s.characterSkinNameEng || null,
  }));
}
