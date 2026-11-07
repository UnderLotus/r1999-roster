import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import sharp from "sharp";

import type {
  CnDeprecatedEntry,
  CnMappedCharacterMetadata,
} from "./cn-ingestion";
import {
  normalizeUttuName,
  UTTU_ASSET_BASE_URL,
  UTTU_GARMENTS_URL,
  UTTU_NAME_LANGS,
  UTTU_PROFILES_URL,
  type UttuCatalog,
  type UttuGarment,
  type UttuNameLang,
} from "./uttu-parser";
import type { NameLang } from "./name-source";
import type { Character, CharacterSkin, PendingCharacter } from "./types";

export const UTTU_SUPPLEMENT_SCHEMA_VERSION = 1;

export const UTTU_SOURCE = {
  profilesUrl: UTTU_PROFILES_URL,
  garmentsUrl: UTTU_GARMENTS_URL,
  assetBaseUrl: UTTU_ASSET_BASE_URL,
} as const;

export interface UttuSupplementSource {
  profilesUrl: string;
  garmentsUrl: string;
  assetBaseUrl: string;
}

export interface UttuSupplementCharacter {
  baseId: number;
  name: string;
  nameEng: string;
  names: Partial<Record<NameLang, string>>;
  rarity: number;
  defaultVariant: string;
  skins: CharacterSkin[];
}

export interface UttuSupplementSkin extends CharacterSkin {
  baseId: number;
}

export interface UttuSupplement {
  schemaVersion: typeof UTTU_SUPPLEMENT_SCHEMA_VERSION;
  source: UttuSupplementSource;
  characters: UttuSupplementCharacter[];
  skins: UttuSupplementSkin[];
}

export class UttuSupplementError extends Error {
  readonly kind = "supplement" as const;

  constructor(message: string) {
    super(message);
    this.name = "UttuSupplementError";
  }
}

/**
 * A primary update now supplies a different ID for a previously admitted
 * default/insight type. The runtime cannot represent both, so publication must
 * stop until the source conflict is resolved.
 */
export class UttuCatchUpConflictError extends UttuSupplementError {
  readonly baseId: number;
  readonly admittedId: string;
  readonly primaryId: string;

  constructor(baseId: number, admitted: CharacterSkin, primary: CharacterSkin) {
    super(
      `Unsupported primary catch-up for baseId ${baseId}: admitted ${admitted.type} ${admitted.variantId} competes with primary ${primary.variantId}. ` +
        `Resolve the upstream mapping so the IDs match or remove the stale supplemental admission, then retry; synchronization stopped before publication.`
    );
    this.name = "UttuCatchUpConflictError";
    this.baseId = baseId;
    this.admittedId = admitted.variantId;
    this.primaryId = primary.variantId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new UttuSupplementError(`${label} must be a non-empty string`);
  }
  return value;
}

function readNames(value: unknown, label: string): Partial<Record<NameLang, string>> {
  if (!isRecord(value)) {
    throw new UttuSupplementError(`${label} names must be an object`);
  }
  const names: Partial<Record<NameLang, string>> = {};
  for (const key of Object.keys(value)) {
    if (!(UTTU_NAME_LANGS as readonly string[]).includes(key)) {
      throw new UttuSupplementError(`${label} has unsupported name language: ${key}`);
    }
    const name = normalizeUttuName(value[key]);
    if (!name) {
      throw new UttuSupplementError(`${label} has an empty or N/A name for ${key}`);
    }
    names[key as UttuNameLang] = name;
  }
  if (!names["zh-CN"] || !names["en-US"]) {
    throw new UttuSupplementError(`${label} names require zh-CN and en-US`);
  }
  return names;
}

function readSkin(value: unknown, label: string): CharacterSkin {
  if (!isRecord(value)) throw new UttuSupplementError(`${label} must be an object`);
  const variantId = requireString(value.variantId, `${label}.variantId`);
  if (!/^\d+$/.test(variantId)) {
    throw new UttuSupplementError(`${label}.variantId must contain only digits`);
  }
  if (value.type !== "default" && value.type !== "insight" && value.type !== "skin") {
    throw new UttuSupplementError(`${label}.type is invalid`);
  }
  const type = value.type;
  const skinName = value.skinName === null ? null : normalizeUttuName(value.skinName);
  const skinNameEng =
    value.skinNameEng === null ? null : normalizeUttuName(value.skinNameEng);
  if (value.skinName !== null && skinName === null) {
    throw new UttuSupplementError(`${label}.skinName is empty or N/A`);
  }
  if (value.skinNameEng !== null && skinNameEng === null) {
    throw new UttuSupplementError(`${label}.skinNameEng is empty or N/A`);
  }
  if (type === "default") {
    if (skinName !== null || skinNameEng !== null) {
      throw new UttuSupplementError(`${label} default skin must not carry skin names`);
    }
  } else if (!skinName && !skinNameEng) {
    throw new UttuSupplementError(`${label} has no usable skin name`);
  }
  return { variantId, type, skinName, skinNameEng };
}

function readSupplementCharacter(value: unknown, index: number): UttuSupplementCharacter {
  if (!isRecord(value)) {
    throw new UttuSupplementError(`Supplement character at index ${index} is invalid`);
  }
  const baseId = value.baseId;
  if (!Number.isSafeInteger(baseId) || (baseId as number) <= 0) {
    throw new UttuSupplementError(`Supplement character ${index} has an invalid baseId`);
  }
  const names = readNames(value.names, `Supplement character ${baseId}`);
  const name = requireString(value.name, `Supplement character ${baseId}.name`);
  const nameEng = requireString(value.nameEng, `Supplement character ${baseId}.nameEng`);
  if (name !== names["zh-CN"] || nameEng !== names["en-US"]) {
    throw new UttuSupplementError(
      `Supplement character ${baseId} name fields disagree with names`
    );
  }
  if (
    !Number.isInteger(value.rarity) ||
    (value.rarity as number) < 2 ||
    (value.rarity as number) > 6
  ) {
    throw new UttuSupplementError(`Supplement character ${baseId} has invalid rarity`);
  }
  const defaultVariant = requireString(
    value.defaultVariant,
    `Supplement character ${baseId}.defaultVariant`
  );
  if (!Array.isArray(value.skins) || value.skins.length === 0) {
    throw new UttuSupplementError(`Supplement character ${baseId} has no skins`);
  }
  const skins = value.skins.map((skin, skinIndex) =>
    readSkin(skin, `Supplement character ${baseId}.skins[${skinIndex}]`)
  );
  const defaults = skins.filter((skin) => skin.type === "default");
  const insights = skins.filter((skin) => skin.type === "insight");
  if (defaults.length !== 1) {
    throw new UttuSupplementError(
      `Supplement character ${baseId} must have exactly one explicit default`
    );
  }
  if (insights.length > 1) {
    throw new UttuSupplementError(
      `Supplement character ${baseId} has multiple insight variants`
    );
  }
  if (defaults[0].variantId !== defaultVariant) {
    throw new UttuSupplementError(
      `Supplement character ${baseId} defaultVariant is not its explicit default skin`
    );
  }
  const unique = new Set<string>();
  for (const skin of skins) {
    if (unique.has(skin.variantId)) {
      throw new UttuSupplementError(
        `Supplement character ${baseId} repeats variant ${skin.variantId}`
      );
    }
    unique.add(skin.variantId);
  }
  return {
    baseId: baseId as number,
    name,
    nameEng,
    names,
    rarity: value.rarity as number,
    defaultVariant,
    skins,
  };
}

function readSupplementSkin(value: unknown, index: number): UttuSupplementSkin {
  if (!isRecord(value)) {
    throw new UttuSupplementError(`Supplement skin at index ${index} is invalid`);
  }
  const baseId = value.baseId;
  if (!Number.isSafeInteger(baseId) || (baseId as number) <= 0) {
    throw new UttuSupplementError(`Supplement skin ${index} has an invalid baseId`);
  }
  const skin = readSkin(value, `Supplement skin ${index}`);
  return { baseId: baseId as number, ...skin };
}

export function parseUttuSupplement(value: unknown): UttuSupplement {
  if (!isRecord(value)) throw new UttuSupplementError("Supplement must be an object");
  if (value.schemaVersion !== UTTU_SUPPLEMENT_SCHEMA_VERSION) {
    throw new UttuSupplementError("Unsupported UTTU supplement schemaVersion");
  }
  if (!isRecord(value.source)) {
    throw new UttuSupplementError("Supplement source metadata is missing");
  }
  const source: UttuSupplementSource = {
    profilesUrl: requireString(value.source.profilesUrl, "source.profilesUrl"),
    garmentsUrl: requireString(value.source.garmentsUrl, "source.garmentsUrl"),
    assetBaseUrl: requireString(value.source.assetBaseUrl, "source.assetBaseUrl"),
  };
  if (!Array.isArray(value.characters) || !Array.isArray(value.skins)) {
    throw new UttuSupplementError("Supplement requires characters[] and skins[]");
  }

  const characters = value.characters.map(readSupplementCharacter);
  const skins = value.skins.map(readSupplementSkin);
  const characterBaseIds = new Set<number>();
  const variants = new Set<string>();
  for (const character of characters) {
    if (characterBaseIds.has(character.baseId)) {
      throw new UttuSupplementError(
        `Duplicate supplement character baseId: ${character.baseId}`
      );
    }
    characterBaseIds.add(character.baseId);
    for (const skin of character.skins) {
      if (variants.has(skin.variantId)) {
        throw new UttuSupplementError(
          `Duplicate supplement variant ID: ${skin.variantId}`
        );
      }
      variants.add(skin.variantId);
    }
  }
  const standaloneTypes = new Map<number, Set<CharacterSkin["type"]>>();
  for (const skin of skins) {
    if (characterBaseIds.has(skin.baseId)) {
      throw new UttuSupplementError(
        `Supplement skin ${skin.variantId} duplicates its new character record`
      );
    }
    if (variants.has(skin.variantId)) {
      throw new UttuSupplementError(
        `Duplicate supplement variant ID: ${skin.variantId}`
      );
    }
    if (skin.type !== "skin") {
      const types = standaloneTypes.get(skin.baseId) ?? new Set();
      if (types.has(skin.type)) {
        throw new UttuSupplementError(
          `Supplement character ${skin.baseId} has multiple retained ${skin.type} variants`
        );
      }
      types.add(skin.type);
      standaloneTypes.set(skin.baseId, types);
    }
    variants.add(skin.variantId);
  }

  characters.sort((a, b) => a.baseId - b.baseId);
  skins.sort((a, b) =>
    a.baseId === b.baseId
      ? a.variantId.localeCompare(b.variantId)
      : a.baseId - b.baseId
  );
  return {
    schemaVersion: UTTU_SUPPLEMENT_SCHEMA_VERSION,
    source,
    characters,
    skins,
  };
}

export function emptyUttuSupplement(): UttuSupplement {
  return {
    schemaVersion: UTTU_SUPPLEMENT_SCHEMA_VERSION,
    source: { ...UTTU_SOURCE },
    characters: [],
    skins: [],
  };
}

export function loadUttuSupplement(file: string): UttuSupplement {
  if (!existsSync(file)) return emptyUttuSupplement();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new UttuSupplementError(
      `Unable to read UTTU supplement ${file}: ${String(error)}`
    );
  }
  return parseUttuSupplement(parsed);
}

export function saveUttuSupplement(file: string, supplement: UttuSupplement): void {
  const serialized = JSON.stringify(parseUttuSupplement(supplement), null, 2) + "\n";
  const temporaryFile = `${file}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporaryFile, serialized, { encoding: "utf8", flag: "wx" });
    renameSync(temporaryFile, file);
  } catch (error) {
    rmSync(temporaryFile, { force: true });
    throw error;
  }
}

function cloneSupplementCharacter(
  character: UttuSupplementCharacter
): UttuSupplementCharacter {
  return {
    ...character,
    names: { ...character.names },
    skins: character.skins.map((skin) => ({ ...skin })),
  };
}

function cloneSupplementSkin(skin: UttuSupplementSkin): UttuSupplementSkin {
  return { ...skin };
}

/** Add only newly admitted records, copying prior ones so validation cannot mutate them. */
function appendUttuAdmissions(
  previous: UttuSupplement,
  characters: readonly UttuSupplementCharacter[],
  skins: readonly UttuSupplementSkin[]
): UttuSupplement {
  const characterByBase = new Map(
    previous.characters.map((character) => [
      character.baseId,
      cloneSupplementCharacter(character),
    ])
  );
  const skinByVariant = new Map(
    previous.skins.map((skin) => [skin.variantId, cloneSupplementSkin(skin)])
  );
  const variantIds = new Set(collectSupplementVariantIds(previous));

  for (const character of characters) {
    if (characterByBase.has(character.baseId)) continue;
    if (character.skins.some((skin) => variantIds.has(skin.variantId))) continue;
    const cloned = cloneSupplementCharacter(character);
    characterByBase.set(cloned.baseId, cloned);
    for (const skin of cloned.skins) variantIds.add(skin.variantId);
  }

  for (const skin of skins) {
    if (variantIds.has(skin.variantId)) continue;
    const character = characterByBase.get(skin.baseId);
    if (character) {
      if (
        skin.type !== "skin" &&
        character.skins.some((candidate) => candidate.type === skin.type)
      ) {
        continue;
      }
      characterByBase.set(skin.baseId, {
        ...character,
        skins: [...character.skins, { ...skin }],
      });
    } else {
      skinByVariant.set(skin.variantId, cloneSupplementSkin(skin));
    }
    variantIds.add(skin.variantId);
  }

  return parseUttuSupplement({
    schemaVersion: UTTU_SUPPLEMENT_SCHEMA_VERSION,
    source: { ...UTTU_SOURCE },
    characters: [...characterByBase.values()],
    skins: [...skinByVariant.values()],
  });
}

function cloneSkin(skin: CharacterSkin): CharacterSkin {
  return { ...skin };
}

function cloneMappedSkin(skin: CharacterSkin): CharacterSkin {
  return {
    variantId: skin.variantId,
    type: skin.type,
    skinName: skin.skinName,
    skinNameEng: skin.skinNameEng,
    ...(skin.isReleased === undefined ? {} : { isReleased: skin.isReleased }),
  };
}

function competingPrimaryVariant(
  admitted: CharacterSkin,
  primary: CnMappedCharacterMetadata
): CharacterSkin | undefined {
  if (admitted.type === "skin") return undefined;
  return primary.skins.find(
    (candidate) =>
      candidate.type === admitted.type &&
      candidate.variantId !== admitted.variantId
  );
}

function cloneMapped(
  mapped: CnMappedCharacterMetadata
): CnMappedCharacterMetadata {
  return {
    ...mapped,
    skins: mapped.skins.map(cloneMappedSkin),
    ...(mapped.names ? { names: { ...mapped.names } } : {}),
  };
}

function mappedFromSupplementCharacter(
  character: UttuSupplementCharacter,
  skins: readonly CharacterSkin[]
): CnMappedCharacterMetadata {
  const insight = skins.find((skin) => skin.type === "insight");
  return {
    baseId: character.baseId,
    name: character.name,
    nameEng: character.nameEng,
    names: { ...character.names },
    rarity: character.rarity,
    skins: skins.map((skin) => ({
      ...cloneMappedSkin(skin),
      ...(skin.type === "skin" ? { isReleased: false } : {}),
    })),
    defaultVariant: character.defaultVariant,
    ...(insight ? { insightVariant: insight.variantId } : {}),
    supplementary: true,
  };
}

export interface EffectiveUttuCatalog {
  mappedCharacters: CnMappedCharacterMetadata[];
  supplement: UttuSupplement;
  returnedToPrimary: string[];
  diagnostics: string[];
}

/**
 * Merge the persisted UTTU supplement into the raw CN mapping without ever
 * replacing primary metadata. Exact variant IDs that primary now owns are
 * removed from the supplement; all other supplement variants remain.
 */
export function mergeUttuSupplement(
  primaryMapped: readonly CnMappedCharacterMetadata[],
  supplement: UttuSupplement
): EffectiveUttuCatalog {
  const primaryByBase = new Map<number, CnMappedCharacterMetadata>();
  const primaryOwner = new Map<string, number>();
  const effectiveByBase = new Map<number, CnMappedCharacterMetadata>();
  for (const mapped of primaryMapped) {
    if (primaryByBase.has(mapped.baseId)) {
      throw new UttuSupplementError(`Duplicate primary baseId: ${mapped.baseId}`);
    }
    primaryByBase.set(mapped.baseId, mapped);
    effectiveByBase.set(mapped.baseId, cloneMapped(mapped));
    for (const skin of mapped.skins) {
      const owner = primaryOwner.get(skin.variantId);
      if (owner !== undefined && owner !== mapped.baseId) {
        throw new UttuSupplementError(
          `Primary variant ${skin.variantId} belongs to both ${owner} and ${mapped.baseId}`
        );
      }
      primaryOwner.set(skin.variantId, mapped.baseId);
    }
  }

  const returned = new Set<string>();
  const diagnostics: string[] = [];
  const retainedNewCharacters: UttuSupplementCharacter[] = [];
  const retainedSkins: UttuSupplementSkin[] = [];

  for (const character of supplement.characters) {
    const primary = primaryByBase.get(character.baseId);
    const surviving: CharacterSkin[] = [];
    for (const skin of character.skins) {
      const owner = primaryOwner.get(skin.variantId);
      if (owner === character.baseId) {
        returned.add(skin.variantId);
        continue;
      }
      if (owner !== undefined) {
        diagnostics.push(
          `UTTU variant ${skin.variantId} conflicts with primary owner ${owner}; rejected`
        );
        continue;
      }
      surviving.push(cloneSkin(skin));
    }

    if (!primary) {
      if (!surviving.some((skin) => skin.type === "default")) {
        diagnostics.push(
          `Supplement character ${character.baseId} no longer has a safe explicit default; skipped`
        );
        continue;
      }
      if (!surviving.some((skin) => skin.variantId === character.defaultVariant)) {
        diagnostics.push(
          `Supplement character ${character.baseId} lost its admitted default; skipped`
        );
        continue;
      }
      const trimmed: UttuSupplementCharacter = {
        ...character,
        names: { ...character.names },
        skins: surviving,
      };
      retainedNewCharacters.push(trimmed);
      effectiveByBase.set(
        character.baseId,
        mappedFromSupplementCharacter(trimmed, surviving)
      );
    } else {
      for (const skin of surviving) {
        const competing = competingPrimaryVariant(skin, primary);
        if (competing) {
          throw new UttuCatchUpConflictError(character.baseId, skin, competing);
        }
        retainedSkins.push({
          baseId: character.baseId,
          ...cloneSkin(skin),
        });
      }
    }
  }

  for (const skin of supplement.skins) {
    const owner = primaryOwner.get(skin.variantId);
    if (owner === skin.baseId) {
      returned.add(skin.variantId);
      continue;
    }
    if (owner !== undefined) {
      diagnostics.push(
        `UTTU variant ${skin.variantId} conflicts with primary owner ${owner}; rejected`
      );
      continue;
    }
    const primary = primaryByBase.get(skin.baseId);
    if (!primary) {
      diagnostics.push(
        `Supplemental skin ${skin.variantId} has no effective character owner; rejected`
      );
      continue;
    }
    const competing = competingPrimaryVariant(skin, primary);
    if (competing) {
      throw new UttuCatchUpConflictError(skin.baseId, skin, competing);
    }
    retainedSkins.push(cloneSupplementSkin(skin));
  }

  for (const skin of retainedSkins) {
    const mapped = effectiveByBase.get(skin.baseId);
    if (!mapped) continue;
    if (mapped.skins.some((candidate) => candidate.variantId === skin.variantId)) {
      continue;
    }
    effectiveByBase.set(skin.baseId, {
      ...mapped,
      skins: [...mapped.skins, cloneMappedSkin(skin)],
    });
  }

  const nextSupplement = parseUttuSupplement({
    schemaVersion: UTTU_SUPPLEMENT_SCHEMA_VERSION,
    source: { ...supplement.source },
    characters: retainedNewCharacters,
    skins: retainedSkins,
  });

  return {
    mappedCharacters: [...effectiveByBase.values()],
    supplement: nextSupplement,
    returnedToPrimary: [...returned].sort((a, b) => a.localeCompare(b)),
    diagnostics: [...new Set(diagnostics)],
  };
}

export interface UttuAdmissionPlan {
  newCharacters: UttuSupplementCharacter[];
  knownSkins: UttuSupplementSkin[];
  diagnostics: string[];
  pending: PendingCharacter[];
}

/**
 * Select only genuinely new exact IDs. Known characters receive added skins
 * only; new characters require their explicit default and all intended
 * variants. Image readiness and admission completion belong to completeUttuAdmissions.
 */
export function planUttuAdmissions(input: {
  catalog: UttuCatalog;
  primaryMapped: readonly CnMappedCharacterMetadata[];
  currentCharacters: readonly Character[];
  supplement: UttuSupplement;
  deprecatedEntries: readonly CnDeprecatedEntry[];
}): UttuAdmissionPlan {
  const diagnostics: string[] = [];
  const pending: PendingCharacter[] = [];
  const deprecatedBaseIds = new Set(input.deprecatedEntries.map((entry) => entry.baseId));
  const deprecatedVariantIds = new Set(
    input.deprecatedEntries.flatMap((entry) =>
      entry.variantId === undefined ? [] : [entry.variantId]
    )
  );

  const currentByBase = new Map(
    input.currentCharacters.map((character) => [character.baseId, character])
  );
  const primaryByBase = new Map(
    input.primaryMapped.map((mapped) => [mapped.baseId, mapped])
  );
  const supplementBaseIds = new Set(
    input.supplement.characters.map((character) => character.baseId)
  );
  const knownBaseIds = new Set([
    ...currentByBase.keys(),
    ...primaryByBase.keys(),
    ...supplementBaseIds,
  ]);
  const owners = new Map<string, number>();
  const addOwnedVariants = (mapped: CnMappedCharacterMetadata): void => {
    for (const skin of mapped.skins) {
      const owner = owners.get(skin.variantId);
      if (owner !== undefined && owner !== mapped.baseId) {
        diagnostics.push(
          `Variant ${skin.variantId} has conflicting catalog owners ${owner} and ${mapped.baseId}`
        );
        continue;
      }
      owners.set(skin.variantId, mapped.baseId);
    }
  };
  for (const character of input.currentCharacters) {
    addOwnedVariants({
      baseId: character.baseId,
      name: character.name,
      nameEng: character.name,
      skins: character.skins,
      defaultVariant: character.defaultVariant,
    });
  }
  for (const mapped of input.primaryMapped) addOwnedVariants(mapped);
  for (const character of input.supplement.characters) {
    addOwnedVariants(mappedFromSupplementCharacter(character, character.skins));
  }
  for (const skin of input.supplement.skins) {
    const owner = owners.get(skin.variantId);
    if (owner !== undefined && owner !== skin.baseId) {
      diagnostics.push(
        `Supplemental variant ${skin.variantId} has conflicting owners ${owner} and ${skin.baseId}`
      );
      continue;
    }
    owners.set(skin.variantId, skin.baseId);
  }

  const profiles = new Map(input.catalog.profiles.map((profile) => [profile.baseId, profile]));
  const newGarments = new Map<number, UttuGarment[]>();
  const conflictBaseIds = new Set<number>();
  const knownSkins: UttuSupplementSkin[] = [];

  for (const garment of input.catalog.garments) {
    if (
      deprecatedBaseIds.has(garment.baseId) ||
      deprecatedVariantIds.has(garment.variantId)
    ) {
      continue;
    }
    const existingOwner = owners.get(garment.variantId);
    if (existingOwner !== undefined) {
      if (existingOwner !== garment.baseId) {
        diagnostics.push(
          `UTTU garment ${garment.variantId} owned by ${garment.baseId} conflicts with exact owner ${existingOwner}; rejected`
        );
        conflictBaseIds.add(garment.baseId);
        conflictBaseIds.add(existingOwner);
      }
      continue;
    }
    if (knownBaseIds.has(garment.baseId)) {
      if (garment.type !== "skin") continue;
      const hasCurrentOrPrimary =
        currentByBase.has(garment.baseId) || primaryByBase.has(garment.baseId);
      if (!hasCurrentOrPrimary) {
        diagnostics.push(
          `UTTU skin ${garment.variantId} waits for supplement character ${garment.baseId}`
        );
        continue;
      }
      knownSkins.push({
        baseId: garment.baseId,
        variantId: garment.variantId,
        type: "skin",
        skinName: garment.skinName,
        skinNameEng: garment.skinNameEng,
      });
      continue;
    }
    const group = newGarments.get(garment.baseId) ?? [];
    group.push(garment);
    newGarments.set(garment.baseId, group);
  }

  const newCharacters: UttuSupplementCharacter[] = [];
  for (const [baseId, garments] of newGarments) {
    const profile = profiles.get(baseId);
    if (!profile) {
      diagnostics.push(`UTTU profile ${baseId} is missing; variants were not admitted`);
      continue;
    }
    const pendingCharacter = (reason: string): PendingCharacter => {
      const defaultGarment = garments.find((garment) => garment.type === "default");
      return {
        baseId,
        variantId: defaultGarment?.variantId ?? String(baseId),
        name: profile.name,
        nameEng: profile.nameEng,
        reason,
      };
    };
    if (input.catalog.incompleteBaseIds.has(baseId)) {
      pending.push(pendingCharacter("UTTU character metadata is incomplete"));
      continue;
    }
    if (conflictBaseIds.has(baseId)) {
      pending.push(pendingCharacter("UTTU variant ownership conflict"));
      continue;
    }
    const defaults = garments.filter((garment) => garment.type === "default");
    if (defaults.length !== 1) {
      pending.push(pendingCharacter("UTTU character has no single explicit default"));
      continue;
    }
    const orderedSkins = [...garments].sort((a, b) => {
      const rank = (type: CharacterSkin["type"]): number =>
        type === "default" ? 0 : type === "insight" ? 1 : 2;
      return rank(a.type) - rank(b.type) || a.variantId.localeCompare(b.variantId);
    });
    newCharacters.push({
      baseId,
      name: profile.name,
      nameEng: profile.nameEng,
      names: { ...profile.names },
      rarity: profile.rarity,
      defaultVariant: defaults[0].variantId,
      skins: orderedSkins.map((garment) => ({
        variantId: garment.variantId,
        type: garment.type,
        skinName: garment.skinName,
        skinNameEng: garment.skinNameEng,
      })),
    });
  }

  for (const profile of input.catalog.profiles) {
    if (knownBaseIds.has(profile.baseId) || newGarments.has(profile.baseId)) continue;
    pending.push({
      baseId: profile.baseId,
      variantId: String(profile.baseId),
      name: profile.name,
      nameEng: profile.nameEng,
      reason: "UTTU character has no associated variant metadata",
    });
  }

  newCharacters.sort((a, b) => a.baseId - b.baseId);
  knownSkins.sort((a, b) =>
    a.baseId === b.baseId
      ? a.variantId.localeCompare(b.variantId)
      : a.baseId - b.baseId
  );
  return { newCharacters, knownSkins, diagnostics, pending };
}

export interface UttuAdmissionOutcome {
  /** False when structural validation rejected this round; an empty round is accepted. */
  accepted: boolean;
  /** Previous records plus this round's admissions; the previous supplement on rejection. */
  supplement: UttuSupplement;
  pending: PendingCharacter[];
  diagnostics: string[];
  admittedCharacters: number;
  admittedSkins: number;
}

/**
 * Complete one admission round: keep only candidates whose exact image the
 * caller validated locally, append them to `previous`, and report whether the
 * round was accepted. Readiness may come from a temporary validated conversion
 * or download and does not imply publication. Missing variants keep a new
 * Character pending and drop a new Skin with a diagnostic. Structural
 * supplement validation failure rejects the whole round and returns `previous`
 * unchanged, so the images prepared for it must be discarded.
 */
export function completeUttuAdmissions(
  previous: UttuSupplement,
  plan: UttuAdmissionPlan,
  availableImageIds: ReadonlySet<string>
): UttuAdmissionOutcome {
  const diagnostics = [...plan.diagnostics];
  const pending = [...plan.pending];
  const knownSkins: UttuSupplementSkin[] = [];
  for (const skin of plan.knownSkins) {
    if (!availableImageIds.has(skin.variantId)) {
      diagnostics.push(
        `UTTU skin ${skin.variantId} is missing its headicon; not admitted`
      );
      continue;
    }
    knownSkins.push(skin);
  }

  const newCharacters: UttuSupplementCharacter[] = [];
  for (const character of plan.newCharacters) {
    const missing = character.skins
      .map((skin) => skin.variantId)
      .filter((variantId) => !availableImageIds.has(variantId));
    if (missing.length > 0) {
      pending.push({
        baseId: character.baseId,
        variantId: character.defaultVariant,
        name: character.name,
        nameEng: character.nameEng,
        reason: `supplemental headicon missing: ${missing.join(", ")}`,
      });
      continue;
    }
    newCharacters.push(character);
  }

  try {
    return {
      accepted: true,
      supplement: appendUttuAdmissions(previous, newCharacters, knownSkins),
      pending,
      diagnostics,
      admittedCharacters: newCharacters.length,
      admittedSkins: knownSkins.length,
    };
  } catch (error) {
    if (error instanceof UttuCatchUpConflictError) throw error;
    if (!(error instanceof UttuSupplementError)) throw error;
    return {
      accepted: false,
      supplement: previous,
      pending,
      diagnostics: [
        ...diagnostics,
        `UTTU admission metadata rejected; preserving previous supplement: ${error.message}`,
      ],
      admittedCharacters: 0,
      admittedSkins: 0,
    };
  }
}

export function collectSupplementVariantIds(supplement: UttuSupplement): string[] {
  return [
    ...new Set([
      ...supplement.characters.flatMap((character) =>
        character.skins.map((skin) => skin.variantId)
      ),
      ...supplement.skins.map((skin) => skin.variantId),
    ]),
  ].sort((a, b) => a.localeCompare(b));
}

export function findMissingSupplementImages(
  supplement: UttuSupplement,
  availableImageIds: ReadonlySet<string>
): string[] {
  return collectSupplementVariantIds(supplement).filter(
    (variantId) => !availableImageIds.has(variantId)
  );
}

export function supplementImageUrl(variantId: string): string {
  return `${UTTU_ASSET_BASE_URL}${variantId}.webp`;
}

export interface SupplementWebpMetadata {
  width: number;
  height: number;
}

function hasLosslessWebpChunk(buffer: Buffer): boolean {
  if (
    buffer.length < 20 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return false;
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    if (chunkType === "VP8L") return true;
    const next = offset + 8 + chunkSize + (chunkSize % 2);
    if (next <= offset) return false;
    offset = next;
  }
  return false;
}

/**
 * UTTU serves lossless WebP headicons. Copying their exact bytes preserves
 * visible pixels; this gate rejects PNGs disguised as WebP and lossy variants.
 */
export async function validateSupplementWebp(
  file: string
): Promise<SupplementWebpMetadata> {
  const bytes = readFileSync(file);
  if (!hasLosslessWebpChunk(bytes)) {
    throw new UttuSupplementError(`${file} is not a lossless WebP image`);
  }
  const metadata = await sharp(file).metadata();
  if (metadata.format !== "webp") {
    throw new UttuSupplementError(`${file} did not decode as WebP`);
  }
  if (
    !Number.isInteger(metadata.width) ||
    !Number.isInteger(metadata.height) ||
    (metadata.width ?? 0) <= 0 ||
    (metadata.height ?? 0) <= 0
  ) {
    throw new UttuSupplementError(`${file} has invalid dimensions`);
  }
  if (metadata.hasAlpha !== true) {
    throw new UttuSupplementError(`${file} has no alpha channel`);
  }
  const decoded = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (decoded.info.channels !== 4) {
    throw new UttuSupplementError(`${file} did not decode as RGBA`);
  }
  return { width: metadata.width, height: metadata.height };
}

/** A failed/empty extraction must never be interpreted as an empty catalog. */
export async function fetchUttuCatalogSafely(
  fetcher: () => Promise<UttuCatalog>
): Promise<{ catalog: UttuCatalog | null; warning: string | null }> {
  try {
    const catalog = await fetcher();
    if (catalog.profiles.length === 0 || catalog.garments.length === 0) {
      throw new Error("UTTU extraction returned an empty catalog");
    }
    return { catalog, warning: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      catalog: null,
      warning: `UTTU refresh failed; using the previously admitted supplement: ${detail}`,
    };
  }
}
