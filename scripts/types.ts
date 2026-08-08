/**
 * Shared script types (v0.6).
 * Mirrors src/types/character.ts for Node-side scripts.
 */

export interface CharacterSkin {
  variantId: string;
  type: "default" | "insight" | "skin";
  skinName: string | null;
  skinNameEng: string | null;
}

export interface Character {
  id: string;
  name: string;
  baseId: number;
  releaseOrder: number;
  enabled: boolean;

  names?: Record<string, string>;

  rarity?: number;
  stage: "live" | "pending-names";
  isReleased: boolean;

  skins: CharacterSkin[];
  defaultVariant: string;

  avatarPosition?: { x: number; y: number };
  source?: { pageUrl?: string; imageUrl?: string };

  // Temporary: Kornblume Id for same-rarity ordering (not persisted)
  _kbId?: number;
}

export interface PendingCharacter {
  baseId: number;
  variantId: string;
  name: string;
  nameEng: string;
  reason: string;
}
