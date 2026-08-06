export interface Character {
  id: string;
  name: string;

  // 多語系名稱（§4.5）：key 為語系代碼
  names?: {
    "zh-CN"?: string;
    "zh-TW"?: string;
    "en-US"?: string;
    "ja-JP"?: string;
    "ko-KR"?: string;
  };

  // MVP 暫緩：由同步腳本取得或留空，UI 不提供對應篩選器
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

export type PortrayLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface CharacterState {
  owned: boolean;
  portray: PortrayLevel;
}
