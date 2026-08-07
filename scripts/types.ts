/**
 * Legacy types (v0.4) — kept for reference.
 * v0.5 scripts define their own inline types matching the new schema.
 * See docs/spec.md §4.6.6 for the current Character interface.
 */

export interface Character {
  id: string;
  name: string;
  rarity?: number;
  releaseOrder: number;
  enabled: boolean;
  images: {
    full: string;
    avatar: string;
    insight?: string;
  };
  avatarPosition?: {
    x: number;
    y: number;
  };
  source?: {
    pageUrl?: string;
    imageUrl?: string;
  };
}

export interface SyncSummary {
  existing: number;
  foundFromSource: number;
  newCharacters: number;
  skipped: number;
  failedImages: number;
  failedCharacters: string[];
}
