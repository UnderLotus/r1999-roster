export interface CharacterSkin {
  variantId: string;
  type: "default" | "insight" | "skin";
  skinName: string | null;
  skinNameEng: string | null;
  /** 海外服（國際/繁中）實裝狀態：true/false；未判定則缺省 */
  isReleased?: boolean;
}

export interface Character {
  id: string;
  name: string;
  baseId: number;
  releaseOrder: number;
  enabled: boolean;

  names?: {
    "zh-CN"?: string;
    "zh-TW"?: string;
    "en-US"?: string;
    "ja-JP"?: string;
    "ko-KR"?: string;
  };

  rarity?: number;

  stage: "live" | "pending-names";
  isReleased: boolean;

  skins: CharacterSkin[];
  defaultVariant: string;

  avatarPosition?: {
    x: number;
    y: number;
  };

  source?: {
    pageUrl?: string;
    imageUrl?: string;
  };
}

export type PortrayLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface CharacterState {
  owned: boolean;
  portray: PortrayLevel;
}
