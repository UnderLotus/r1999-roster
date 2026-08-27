import type { Character, CharacterState, PortrayLevel } from "../types/character";
import { resolveModeVariant } from "../utils/skins";

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

/** Resolve a requested skin or the legal mode fallback under Future Sight policy. */
function reconcileBoxVariant(
  character: Character,
  requestedVariant: string | undefined,
  mode: SkinMode,
  showFutureSight: boolean
): BoxVariantResolution {
  const allowed = (variantId: string | undefined): variantId is string => {
    if (!variantId) return false;
    const skin = character.skins.find((entry) => entry.variantId === variantId);
    return Boolean(skin && (showFutureSight || skin.isReleased !== false));
  };

  if (allowed(requestedVariant)) {
    return { variantId: requestedVariant, preserved: true };
  }

  const preferred = resolveModeVariant(character, mode);
  if (allowed(preferred)) return { variantId: preferred, preserved: false };

  const initial = `${character.baseId}01`;
  if (allowed(initial)) return { variantId: initial, preserved: false };

  const fallback = character.skins.find(
    (skin) => showFutureSight || skin.isReleased !== false
  );
  if (fallback) return { variantId: fallback.variantId, preserved: false };

  throw new Error(`Character ${character.id} has no allowed skin fallback`);
}

/**
 * Reconcile an untrusted Box candidate against an explicit character catalog.
 * The input is never mutated; callers receive a complete, legal Box snapshot.
 */
export function reconcileBox(
  candidate: BoxState,
  catalog: readonly Character[]
): BoxState {
  const catalogById = new Map(catalog.map((character) => [character.id, character]));
  const next: BoxState = {
    characters: {},
    activeVariant: {},
    customVariants: {},
    defaultSkinMode: candidate.defaultSkinMode,
    showFutureSight: candidate.showFutureSight,
  };

  for (const [id, state] of Object.entries(candidate.characters)) {
    const character = catalogById.get(id);
    if (!character || !state?.owned) continue;
    if (!candidate.showFutureSight && !character.isReleased) continue;

    next.characters[id] = {
      owned: true,
      portray: normalizeBoxPortray(state.portray),
    };

    const variant = reconcileBoxVariant(
      character,
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
