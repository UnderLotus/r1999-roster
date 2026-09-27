import type { Character, CharacterSkin } from "../types/character";

export type VariantSelectionMode = "initial" | "insight";

type VariantType = CharacterSkin["type"];

/**
 * Catalog-backed identity lookups shared by runtime domain code and mapping
 * adapters. Variant IDs are compared as exact strings; their digits do not
 * participate in ownership or default selection.
 */
export interface VariantIdentityCatalog {
  readonly characters: readonly Character[];
  getCharacterById(id: string): Character | undefined;
  getCharacterByBaseId(baseId: number): Character | undefined;
  getCharacterByVariantId(variantId: string): Character | undefined;
  getSkins(characterId: string): readonly CharacterSkin[];
  ownsVariant(characterId: string, variantId: string): boolean;
  getDefaultVariant(characterId: string): string | undefined;
  getInsightVariant(characterId: string): string | undefined;
  resolveModeVariant(
    characterId: string,
    mode: VariantSelectionMode
  ): string | undefined;
}

function describeCharacter(character: Character): string {
  return character.id || String(character.baseId);
}

function requireUniqueVariant(
  variants: Map<string, Character>,
  variantId: string,
  character: Character
): void {
  const existing = variants.get(variantId);
  if (existing) {
    throw new Error(
      `Variant ${variantId} belongs to both ${describeCharacter(existing)} and ${describeCharacter(character)}`
    );
  }
  variants.set(variantId, character);
}

/**
 * Select one explicitly typed variant from a mapping result.
 * Ambiguous type metadata is rejected instead of silently choosing by order.
 */
export function selectVariantByType(
  skins: readonly Pick<CharacterSkin, "variantId" | "type">[],
  type: VariantType
): string | undefined {
  const matches = skins.filter((skin) => skin.type === type);
  if (matches.length > 1) {
    throw new Error(`Multiple ${type} variants are not supported`);
  }
  return matches[0]?.variantId;
}

/** Resolve explicit default/insight metadata without inspecting variant digits. */
export function resolveCharacterVariant(
  character: Pick<Character, "defaultVariant" | "skins">,
  mode: VariantSelectionMode
): string {
  if (mode === "insight") {
    return selectVariantByType(character.skins, "insight") ?? character.defaultVariant;
  }
  return character.defaultVariant;
}

/**
 * Build a validated identity index. The checks are intentionally strict: a
 * malformed catalog would otherwise turn ownership validation into a silent
 * Map overwrite.
 */
export function createVariantIdentityCatalog(
  characters: readonly Character[]
): VariantIdentityCatalog {
  const byId = new Map<string, Character>();
  const byBaseId = new Map<number, Character>();
  const byVariantId = new Map<string, Character>();

  for (const character of characters) {
    if (!character || typeof character !== "object") {
      throw new Error("Character catalog contains an invalid entry");
    }
    if (typeof character.id !== "string" || character.id.length === 0) {
      throw new Error("Character catalog entry has an invalid id");
    }
    if (byId.has(character.id)) {
      throw new Error(`Duplicate Character id: ${character.id}`);
    }
    if (!Number.isSafeInteger(character.baseId) || character.baseId < 0) {
      throw new Error(`Character ${character.id} has an invalid baseId`);
    }
    if (byBaseId.has(character.baseId)) {
      throw new Error(`Duplicate Character baseId: ${character.baseId}`);
    }
    if (!Array.isArray(character.skins)) {
      throw new Error(`Character ${character.id} has no variant catalog`);
    }
    if (typeof character.defaultVariant !== "string" || character.defaultVariant.length === 0) {
      throw new Error(`Character ${character.id} has an invalid defaultVariant`);
    }

    const localVariants = new Set<string>();
    for (const skin of character.skins) {
      if (!skin || typeof skin.variantId !== "string" || skin.variantId.length === 0) {
        throw new Error(`Character ${character.id} has an invalid variant id`);
      }
      if (localVariants.has(skin.variantId)) {
        throw new Error(
          `Character ${character.id} lists variant ${skin.variantId} more than once`
        );
      }
      localVariants.add(skin.variantId);
      requireUniqueVariant(byVariantId, skin.variantId, character);
    }

    const defaultSkin = character.skins.find(
      (skin) => skin.variantId === character.defaultVariant
    );
    if (!defaultSkin) {
      throw new Error(
        `Character ${character.id} defaultVariant ${character.defaultVariant} is not owned by the Character`
      );
    }
    if (defaultSkin.type !== "default") {
      throw new Error(
        `Character ${character.id} defaultVariant ${character.defaultVariant} is not typed as default`
      );
    }
    selectVariantByType(character.skins, "default");
    selectVariantByType(character.skins, "insight");

    byId.set(character.id, character);
    byBaseId.set(character.baseId, character);
  }

  return {
    characters,
    getCharacterById: (id) => byId.get(id),
    getCharacterByBaseId: (baseId) => byBaseId.get(baseId),
    getCharacterByVariantId: (variantId) => byVariantId.get(variantId),
    getSkins: (characterId) => byId.get(characterId)?.skins ?? [],
    ownsVariant: (characterId, variantId) =>
      byVariantId.get(variantId)?.id === characterId,
    getDefaultVariant: (characterId) => byId.get(characterId)?.defaultVariant,
    getInsightVariant: (characterId) => {
      const character = byId.get(characterId);
      return character ? selectVariantByType(character.skins, "insight") : undefined;
    },
    resolveModeVariant: (characterId, mode) => {
      const character = byId.get(characterId);
      return character ? resolveCharacterVariant(character, mode) : undefined;
    },
  };
}
