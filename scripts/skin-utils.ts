/**
 * Low-level raw CN mapping conversion used by the pure cn-ingestion plan.
 *
 * Variant ownership and default selection remain delegated to the Candidate 1
 * variant-identity module; this file only normalizes upstream metadata.
 */

import { selectVariantByType } from "../src/domain/variant-identity";
import type { Character } from "./types";

function explicitSkinType(
  description: string | undefined
): Character["skins"][number]["type"] | undefined {
  if (!description) return undefined;
  if (description.includes("初始")) return "default";
  if (description.includes("进阶")) return "insight";
  return undefined;
}

export function skinTypeFromId(
  variantId: number,
  ownerBaseId?: number,
  description?: string
): Character["skins"][number]["type"] {
  const mappedType = explicitSkinType(description);
  if (mappedType) return mappedType;

  // CN portrait skins can use baseId + "00" + sequence (for example
  // 30880001). The mapping entry owns the variant; do not infer ownership by
  // dividing the eight-digit ID before applying ordinary suffix rules.
  const variantText = String(variantId);
  const ownerPrefix = ownerBaseId === undefined ? undefined : `${ownerBaseId}00`;
  if (
    ownerPrefix !== undefined &&
    variantText.length === ownerPrefix.length + 2 &&
    variantText.startsWith(ownerPrefix)
  ) {
    return "skin";
  }

  const suffix = variantId % 100;
  if (suffix === 1) return "default";
  if (suffix === 2) return "insight";
  return "skin";
}

export interface ArcanistSkinFull {
  id: number;
  des?: string;
  characterSkin: string;
  characterSkinNameEng: string;
}

export interface ArcanistEntryFull {
  id: number;
  name: string;
  nameEng: string;
  live2d: ArcanistSkinFull[];
}

export interface MappedCharacterVariants {
  skins: Character["skins"];
  defaultVariant: string;
  insightVariant?: string;
}

export function buildSkins(entry: ArcanistEntryFull): Character["skins"] {
  return entry.live2d.map((s) => ({
    variantId: String(s.id),
    type: skinTypeFromId(s.id, entry.id, s.des),
    skinName: s.characterSkin || null,
    skinNameEng: s.characterSkinNameEng || null,
  }));
}

/** Convert one raw CN mapping entry into explicit Character metadata. */
export function mapCharacterVariants(
  entry: ArcanistEntryFull
): MappedCharacterVariants {
  const skins = buildSkins(entry);
  const defaultVariant = selectVariantByType(skins, "default");
  if (!defaultVariant) {
    throw new Error(`CN mapping entry ${entry.id} has no default variant`);
  }
  return {
    skins,
    defaultVariant,
    insightVariant: selectVariantByType(skins, "insight"),
  };
}
