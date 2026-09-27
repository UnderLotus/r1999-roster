import type { Character, CharacterState, PortrayLevel } from "../types/character";
import { createVariantIdentityCatalog } from "./variant-identity";

export type SkinMode = "initial" | "insight";

export interface BoxState {
  characters: Record<string, CharacterState>;
  activeVariant: Record<string, string>;
  customVariants: Record<string, true>;
  defaultSkinMode: SkinMode;
  showFutureSight: boolean;
}

export function normalizeBoxPortray(value: unknown): PortrayLevel {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value)
  ) {
    return 0;
  }
  return Math.min(5, Math.max(0, value)) as PortrayLevel;
}

interface BoxVariantResolution {
  variantId: string;
  preserved: boolean;
}

/** Resolve a requested variant or the legal explicit mode fallback. */
function reconcileBoxVariant(
  characterId: string,
  identity: ReturnType<typeof createVariantIdentityCatalog>,
  requestedVariant: string | undefined,
  mode: SkinMode,
  showFutureSight: boolean
): BoxVariantResolution {
  const allowed = (variantId: string | undefined): variantId is string => {
    if (!variantId || !identity.ownsVariant(characterId, variantId)) return false;
    const skin = identity.getSkins(characterId).find(
      (entry) => entry.variantId === variantId
    );
    return Boolean(skin && (showFutureSight || skin.isReleased !== false));
  };

  if (allowed(requestedVariant)) {
    return { variantId: requestedVariant, preserved: true };
  }

  const preferred = identity.resolveModeVariant(characterId, mode);
  if (allowed(preferred)) return { variantId: preferred, preserved: false };

  const initial = identity.getDefaultVariant(characterId);
  if (allowed(initial)) return { variantId: initial, preserved: false };

  const fallback = identity.getSkins(characterId).find(
    (skin) => showFutureSight || skin.isReleased !== false
  );
  if (fallback) return { variantId: fallback.variantId, preserved: false };

  throw new Error(`Character ${characterId} has no allowed skin fallback`);
}

/**
 * Reconcile an untrusted Box candidate against an explicit character catalog.
 * The input is never mutated; callers receive a complete, legal Box snapshot.
 */
export function reconcileBox(
  candidate: BoxState,
  catalog: readonly Character[]
): BoxState {
  const identity = createVariantIdentityCatalog(catalog);
  const next: BoxState = {
    characters: {},
    activeVariant: {},
    customVariants: {},
    defaultSkinMode: candidate.defaultSkinMode,
    showFutureSight: candidate.showFutureSight,
  };

  for (const [id, state] of Object.entries(candidate.characters)) {
    const character = identity.getCharacterById(id);
    if (!character || !state?.owned) continue;
    if (!candidate.showFutureSight && !character.isReleased) continue;

    next.characters[id] = {
      owned: true,
      portray: normalizeBoxPortray(state.portray),
    };

    const variant = reconcileBoxVariant(
      id,
      identity,
      candidate.activeVariant[id],
      candidate.defaultSkinMode,
      candidate.showFutureSight
    );
    next.activeVariant[id] = variant.variantId;

    if (variant.preserved && candidate.customVariants[id] === true) {
      next.customVariants[id] = true;
    }
  }

  return next;
}
