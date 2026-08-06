export interface Character {
  id: string;
  name: string;
  rarity?: number;
  releaseOrder: number;
  enabled: boolean;
  images: {
    full: string;
    avatar: string;
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
