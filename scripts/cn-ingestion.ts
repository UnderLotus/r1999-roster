import type { Character, CharacterSkin, PendingCharacter } from "./types";
import {
  mapCharacterVariants,
  type ArcanistEntryFull,
} from "./skin-utils";

/**
 * Pure CN ingestion planning.
 *
 * The adapters own I/O, conversion, logging, and writes. This module owns the
 * CN decisions that must stay identical between sync-assets and
 * build-characters: mapped ownership metadata, explicit defaults, existing
 * Character reconciliation, new Character admission, pending state,
 * deprecated skips, and deterministic evidence.
 */

export type { ArcanistEntryFull };

export interface CnMappedCharacterMetadata {
  readonly baseId: number;
  readonly name: string;
  readonly nameEng: string;
  readonly skins: readonly CharacterSkin[];
  readonly defaultVariant: string;
  readonly insightVariant?: string;
}

export interface CnDeprecatedEntry {
  readonly baseId: number;
  readonly variantId?: string;
  readonly name?: string;
  readonly nameEng?: string;
  readonly note?: string;
}

/** Evidence supplied by a CN adapter's warning-only filename heuristic. */
export interface CnDiagnosticCandidate {
  readonly variantId: string;
  readonly code: "unmapped-player-like-headicon";
  readonly message: string;
}

export interface CnIngestionDiagnostic {
  readonly id: string;
  readonly code: CnDiagnosticCandidate["code"];
  readonly variantId: string;
  readonly message: string;
  readonly blocking: false;
}

export interface CnExistingCharacterReconciliation {
  readonly baseId: number;
  readonly characterId: string;
  readonly mapped: CnMappedCharacterMetadata;
  readonly before: Character;
  readonly after: Character;
}

export interface CnStageProjection {
  readonly readyNewCharacters: readonly Character[];
  readonly pendingNewCharacters: readonly PendingCharacter[];
}

export interface CnIngestionSummary {
  readonly currentCharacterCount: number;
  readonly mappedCharacterCount: number;
  readonly mappedVariantCount: number;
  readonly existingReconciliationCount: number;
  readonly readyNewCharacterCount: { readonly sync: number; readonly build: number };
  readonly pendingNewCharacterCount: { readonly sync: number; readonly build: number };
  readonly deprecatedSkipCount: number;
  readonly diagnosticCount: number;
  /** All mapped variants required by the current/new catalog projection. */
  readonly requiredVariantCount: number;
  /** Variants actually safe for sync's source-PNG staging pass. */
  readonly stagedVariantCount: number;
}

export interface CnIngestionInput {
  readonly currentCharacters: readonly Character[];
  /** Fresh mapping already converted to explicit Character/Variant metadata. */
  readonly mappedCharacters: readonly CnMappedCharacterMetadata[];
  /** IDs found in the source PNG inventory, without filename extensions. */
  readonly sourceImageIds: ReadonlySet<string>;
  /** IDs found in the local WebP inventory, without filename extensions. */
  readonly localImageIds: ReadonlySet<string>;
  readonly deprecatedEntries: readonly CnDeprecatedEntry[];
  /** Optional nonblocking evidence produced by the CN adapter heuristic. */
  readonly diagnosticCandidates?: readonly CnDiagnosticCandidate[];
}

export interface CnIngestionPlan {
  /** Current + mapped existing + every non-deprecated new mapping variant. */
  readonly requiredVariantIds: readonly string[];
  /** Current + mapped existing + source-complete new variants. */
  readonly stagedVariantIds: readonly string[];
  readonly existingCharacterReconciliations: readonly CnExistingCharacterReconciliation[];
  readonly sync: CnStageProjection;
  readonly build: CnStageProjection;
  readonly deprecatedSkips: readonly CnMappedCharacterMetadata[];
  readonly diagnostics: readonly CnIngestionDiagnostic[];
  readonly summary: CnIngestionSummary;
}

export function mapCnCharacterMetadata(
  entry: ArcanistEntryFull
): CnMappedCharacterMetadata {
  const mapped = mapCharacterVariants(entry);
  return {
    baseId: entry.id,
    name: entry.name,
    nameEng: entry.nameEng,
    skins: mapped.skins.map(cloneSkin),
    defaultVariant: mapped.defaultVariant,
    insightVariant: mapped.insightVariant,
  };
}

export function cloneCharacterRecord(character: Character): Character {
  const clone: Character = {
    ...character,
    skins: character.skins.map(cloneSkin),
  };
  if (character.names) clone.names = { ...character.names };
  if (character.source) clone.source = { ...character.source };
  if (character.avatarPosition) clone.avatarPosition = { ...character.avatarPosition };
  return clone;
}

function cloneSkin(skin: CharacterSkin): CharacterSkin {
  return { ...skin };
}

function cloneMappedCharacter(
  mapped: CnMappedCharacterMetadata
): CnMappedCharacterMetadata {
  return {
    ...mapped,
    skins: mapped.skins.map(cloneSkin),
  };
}

function createNewCharacter(mapped: CnMappedCharacterMetadata): Character {
  return {
    id: mapped.defaultVariant,
    name: mapped.name,
    baseId: mapped.baseId,
    releaseOrder: 0,
    enabled: true,
    skins: mapped.skins.map(cloneSkin),
    defaultVariant: mapped.defaultVariant,
    stage: "pending-names",
    isReleased: false,
  };
}

function reconcileExistingCharacter(
  character: Character,
  mapped: CnMappedCharacterMetadata
): CnExistingCharacterReconciliation {
  const before = cloneCharacterRecord(character);
  const previousVariants = new Map(
    character.skins.map((skin) => [skin.variantId, skin])
  );

  const after = cloneCharacterRecord(character);
  after.skins = mapped.skins.map((skin) => {
    const next = cloneSkin(skin);
    const previous = previousVariants.get(next.variantId);
    if (previous) {
      // Omitted isReleased means released in the compact data contract. Keep
      // omission as omission; only a genuinely new mapped skin gets false.
      if (previous.isReleased === undefined) {
        delete next.isReleased;
      } else {
        next.isReleased = previous.isReleased;
      }
    } else if (next.type === "skin") {
      next.isReleased = false;
    }
    return next;
  });
  after.defaultVariant = mapped.defaultVariant;

  return {
    baseId: character.baseId,
    characterId: character.id,
    mapped: cloneMappedCharacter(mapped),
    before,
    after,
  };
}

function sortedUniqueVariantIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

function missingVariantIds(
  mapped: CnMappedCharacterMetadata,
  available: ReadonlySet<string>,
  includeAllSkins: boolean
): string[] {
  const expected = includeAllSkins
    ? mapped.skins.map((skin) => skin.variantId)
    : [mapped.defaultVariant];
  return expected
    .filter((variantId) => !available.has(variantId))
    .sort((a, b) => a.localeCompare(b));
}

function pendingCharacter(
  mapped: CnMappedCharacterMetadata,
  reason: string
): PendingCharacter {
  return {
    baseId: mapped.baseId,
    variantId: mapped.defaultVariant,
    name: mapped.name,
    nameEng: mapped.nameEng,
    reason,
  };
}

function buildDiagnostics(
  candidates: readonly CnDiagnosticCandidate[]
): CnIngestionDiagnostic[] {
  const byId = new Map<string, CnIngestionDiagnostic>();
  for (const candidate of candidates) {
    const id = `cn-mapping-lag:${candidate.variantId}`;
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        code: candidate.code,
        variantId: candidate.variantId,
        message: candidate.message,
        blocking: false,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function validateUniqueBaseIds(
  characters: readonly Character[],
  label: string
): Map<number, Character> {
  const byBaseId = new Map<number, Character>();
  for (const character of characters) {
    if (byBaseId.has(character.baseId)) {
      throw new Error(`Duplicate ${label} baseId: ${character.baseId}`);
    }
    byBaseId.set(character.baseId, character);
  }
  return byBaseId;
}

function validateMappedCharacters(
  mappedCharacters: readonly CnMappedCharacterMetadata[]
): Map<number, CnMappedCharacterMetadata> {
  const byBaseId = new Map<number, CnMappedCharacterMetadata>();
  for (const mapped of mappedCharacters) {
    if (byBaseId.has(mapped.baseId)) {
      throw new Error(`Duplicate CN mapping baseId: ${mapped.baseId}`);
    }
    byBaseId.set(mapped.baseId, mapped);
  }
  return byBaseId;
}

/**
 * Build the complete deterministic CN decision plan without touching input
 * records. Source completeness and local-default completeness intentionally
 * remain separate projections: sync requires every mapped source PNG, while
 * standalone build:characters historically admits a new Character when only
 * its mapped default local avatar exists.
 */
export function planCnIngestion(input: CnIngestionInput): CnIngestionPlan {
  const currentByBaseId = validateUniqueBaseIds(input.currentCharacters, "current Character");
  const mappedByBaseId = validateMappedCharacters(input.mappedCharacters);
  const deprecatedBaseIds = new Set(input.deprecatedEntries.map((entry) => entry.baseId));

  const existingReconciliations = input.currentCharacters
    .flatMap((character) => {
      const mapped = mappedByBaseId.get(character.baseId);
      return mapped ? [reconcileExistingCharacter(character, mapped)] : [];
    });

  const newMapped = input.mappedCharacters
    .filter((mapped) => !currentByBaseId.has(mapped.baseId))
    .sort((a, b) => a.baseId - b.baseId);
  const deprecatedSkips = newMapped
    .filter((mapped) => deprecatedBaseIds.has(mapped.baseId))
    .map(cloneMappedCharacter);
  const eligibleNew = newMapped.filter((mapped) => !deprecatedBaseIds.has(mapped.baseId));

  const syncReady: Character[] = [];
  const syncPending: PendingCharacter[] = [];
  for (const mapped of eligibleNew) {
    const missing = missingVariantIds(mapped, input.sourceImageIds, true);
    if (missing.length === 0) {
      syncReady.push(createNewCharacter(mapped));
    } else {
      syncPending.push(
        pendingCharacter(
          mapped,
          `headicon missing in CN asset repo: ${missing.join(", ")}`
        )
      );
    }
  }

  const buildReady: Character[] = [];
  const buildPending: PendingCharacter[] = [];
  for (const mapped of eligibleNew) {
    const missing = missingVariantIds(mapped, input.localImageIds, false);
    if (missing.length === 0) {
      buildReady.push(createNewCharacter(mapped));
    } else {
      buildPending.push(
        pendingCharacter(mapped, "headicon not yet in CN asset repo")
      );
    }
  }

  const currentVariantIds = input.currentCharacters.flatMap((character) =>
    character.skins.map((skin) => skin.variantId)
  );
  const mappedExistingVariantIds = existingReconciliations.flatMap((reconciliation) =>
    reconciliation.mapped.skins.map((skin) => skin.variantId)
  );
  const eligibleMappedVariantIds = eligibleNew.flatMap((mapped) =>
    mapped.skins.map((skin) => skin.variantId)
  );
  const stagedNewVariantIds = syncReady.flatMap((character) =>
    character.skins.map((skin) => skin.variantId)
  );
  const requiredVariantIds = sortedUniqueVariantIds([
    ...currentVariantIds,
    ...mappedExistingVariantIds,
    ...eligibleMappedVariantIds,
  ]);
  const stagedVariantIds = sortedUniqueVariantIds([
    ...currentVariantIds,
    ...mappedExistingVariantIds,
    ...stagedNewVariantIds,
  ]);
  const diagnostics = buildDiagnostics(input.diagnosticCandidates ?? []);

  const sync: CnStageProjection = {
    readyNewCharacters: syncReady,
    pendingNewCharacters: syncPending,
  };
  const build: CnStageProjection = {
    readyNewCharacters: buildReady,
    pendingNewCharacters: buildPending,
  };

  return {
    requiredVariantIds,
    stagedVariantIds,
    existingCharacterReconciliations: existingReconciliations,
    sync,
    build,
    deprecatedSkips,
    diagnostics,
    summary: {
      currentCharacterCount: input.currentCharacters.length,
      mappedCharacterCount: input.mappedCharacters.length,
      mappedVariantCount: input.mappedCharacters.reduce(
        (count, mapped) => count + mapped.skins.length,
        0
      ),
      existingReconciliationCount: existingReconciliations.length,
      readyNewCharacterCount: {
        sync: sync.readyNewCharacters.length,
        build: build.readyNewCharacters.length,
      },
      pendingNewCharacterCount: {
        sync: sync.pendingNewCharacters.length,
        build: build.pendingNewCharacters.length,
      },
      deprecatedSkipCount: deprecatedSkips.length,
      diagnosticCount: diagnostics.length,
      requiredVariantCount: requiredVariantIds.length,
      stagedVariantCount: stagedVariantIds.length,
    },
  };
}
