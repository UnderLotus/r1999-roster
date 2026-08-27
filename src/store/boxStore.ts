import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { characters } from "../data/characters";
import { normalizeBoxPortray, reconcileBox } from "../domain/box";
import type { BoxState, SkinMode } from "../domain/box";
import type { CharacterState, PortrayLevel } from "../types/character";
import { resolveModeVariant } from "../utils/skins";
import { createSafeStorage } from "../utils/storage";

export type FilterMode = "all" | "owned" | "unowned";
export type LangCode = "zh-CN" | "zh-TW" | "en-US" | "ja-JP" | "ko-KR";
export type { SkinMode } from "../domain/box";

export interface BoxStore extends BoxState {
  filterMode: FilterMode;
  search: string;
  rarityFilter: number[];
  userId: string;
  displayLang: LangCode;
  /** 使用者是否手動選過語系（false = 首次造訪，可自動偵測瀏覽器語系） */
  langChosen: boolean;

  activateCharacter: (id: string) => void;
  decreasePortray: (id: string) => void;
  resetAll: () => void;
  setFilterMode: (mode: FilterMode) => void;
  setSearch: (text: string) => void;
  setRarityFilter: (rarities: number[]) => void;
  setUserId: (id: string) => void;
  setDisplayLang: (lang: LangCode) => void;
  setActiveVariant: (id: string, variantId: string) => void;
  setShowFutureSight: (v: boolean) => void;
  setSkinMode: (mode: SkinMode) => void;
  /** 匯入分享 token 的候選 Box，經 domain reconciliation 後覆蓋 */
  importBox: (payload: BoxState) => void;
}

const emptyState: CharacterState = { owned: false, portray: 0 };

/* ---------- 持久化資料清理（localStorage 為不可信資料） ---------- */

type PersistedBoxSnapshot = Pick<
  BoxStore,
  | "characters"
  | "displayLang"
  | "activeVariant"
  | "customVariants"
  | "userId"
  | "langChosen"
  | "showFutureSight"
  | "defaultSkinMode"
>;

export interface PersistedBoxState {
  characters?: Record<string, CharacterState>;
  displayLang?: unknown;
  activeVariant?: unknown;
  customVariants?: unknown;
  userId?: unknown;
  langChosen?: unknown;
  showFutureSight?: unknown;
  defaultSkinMode?: unknown;
}

const LANG_CODES: LangCode[] = [
  "zh-CN",
  "zh-TW",
  "en-US",
  "ja-JP",
  "ko-KR",
];

function normalizeDisplayLang(value: unknown): LangCode {
  return typeof value === "string" &&
    (LANG_CODES as string[]).includes(value)
    ? (value as LangCode)
    : "en-US";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** User ID 長度上限（UI 輸入與 store 統一） */
export const USER_ID_MAX = 20;

function normalizeUserId(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, USER_ID_MAX) : "";
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeActiveVariant(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [id, variantId] of Object.entries(value)) {
    if (typeof variantId === "string" && variantId.length > 0) {
      result[id] = variantId;
    }
  }
  return result;
}

function normalizeCustomVariants(value: unknown): Record<string, true> {
  if (!isRecord(value)) return {};
  const result: Record<string, true> = {};
  for (const [id, custom] of Object.entries(value)) {
    if (custom === true) {
      result[id] = true;
    }
  }
  return result;
}

function normalizeSkinMode(value: unknown): SkinMode {
  return value === "insight" ? "insight" : "initial";
}

/** 清理持久化狀態 */
export function migratePersistedState(raw: unknown): PersistedBoxState {
  const data = isRecord(raw) ? raw : {};
  const rawCharacters = isRecord(data.characters) ? data.characters : {};

  const characters: Record<string, CharacterState> = {};
  for (const [id, state] of Object.entries(rawCharacters)) {
    if (!isRecord(state)) continue;
    const owned = state.owned === true;
    if (!owned) continue;
    characters[id] = {
      owned: true,
      portray: normalizeBoxPortray(state.portray),
    };
  }

  return {
    characters,
    displayLang: normalizeDisplayLang(data.displayLang),
    activeVariant: normalizeActiveVariant(data.activeVariant),
    customVariants: normalizeCustomVariants(data.customVariants),
    userId: normalizeUserId(data.userId),
    langChosen: normalizeBoolean(data.langChosen),
    showFutureSight: normalizeBoolean(data.showFutureSight),
    defaultSkinMode: normalizeSkinMode(data.defaultSkinMode),
  };
}

export function partializeBoxStore(state: BoxStore): PersistedBoxSnapshot {
  return {
    characters: state.characters,
    displayLang: state.displayLang,
    activeVariant: state.activeVariant,
    customVariants: state.customVariants,
    userId: state.userId,
    langChosen: state.langChosen,
    showFutureSight: state.showFutureSight,
    defaultSkinMode: state.defaultSkinMode,
  };
}

/* ---------- store ---------- */

/** 依持久化版本遷移狀態（測試可直接呼叫驗證 version 分支） */
export function migratePersisted(
  persisted: unknown,
  version: number | undefined
): PersistedBoxState {
  const migrated = migratePersistedState(persisted);

  // 語系：任何既有資料（version 0–6）一律視為已選擇語系，
  // 避免舊使用者的 displayLang 被瀏覽器語系覆寫；
  // 僅全新訪客（無 persisted → version undefined）自動偵測。
  const langChosen = version == null ? false : version >= 7
    ? migrated.langChosen ?? false
    : true;

  // v5 → v6: 舊資料的 02 activeVariant 不再代表使用者選擇；
  // 版本 6 以前丟棄 variant/custom，交由 Box model 依 initial 補齊。
  const keepsVariantSelections = version !== undefined && version >= 6;
  const candidate: BoxState = {
    characters: migrated.characters ?? {},
    activeVariant: keepsVariantSelections
      ? (migrated.activeVariant as Record<string, string> | undefined) ?? {}
      : {},
    customVariants: keepsVariantSelections
      ? (migrated.customVariants as Record<string, true> | undefined) ?? {}
      : {},
    defaultSkinMode: keepsVariantSelections
      ? normalizeSkinMode(migrated.defaultSkinMode)
      : "initial",
    showFutureSight: migrated.showFutureSight === true,
  };
  const reconciled = reconcileBox(candidate, characters);

  return {
    ...reconciled,
    displayLang: migrated.displayLang,
    userId: migrated.userId ?? "",
    langChosen,
  };
}

function setCharacter(
  set: (fn: (state: BoxStore) => Partial<BoxStore>) => void,
  id: string,
  next: CharacterState
): void {
  set((state) => ({
    characters: { ...state.characters, [id]: next },
  }));
}

export const useBoxStore = create<BoxStore>()(
  persist(
    (set, get) => ({
      characters: {},
      activeVariant: {},
      customVariants: {},
      filterMode: "all",
      search: "",
      rarityFilter: [],
      userId: "",
      displayLang: "en-US",
      langChosen: false,
      showFutureSight: false,
      defaultSkinMode: "initial",

      activateCharacter: (id) => {
        const current = get().characters[id];

        if (!current?.owned) {
          setCharacter(set, id, { owned: true, portray: 0 });
          return;
        }

        if (current.portray < 5) {
          setCharacter(set, id, {
            owned: true,
            portray: (current.portray + 1) as PortrayLevel,
          });
        }
      },

      decreasePortray: (id) => {
        const current = get().characters[id];
        if (!current?.owned) return;

        if (current.portray > 0) {
          setCharacter(set, id, {
            owned: true,
            portray: (current.portray - 1) as PortrayLevel,
          });
        } else {
          set((state) => {
            const next = { ...state.characters };
            const nextVariant = { ...state.activeVariant };
            const nextCustom = { ...state.customVariants };
            delete next[id];
            delete nextVariant[id];
            delete nextCustom[id];
            return { characters: next, activeVariant: nextVariant, customVariants: nextCustom };
          });
        }
      },

      // 只重置角色資料；保留 userId、過濾、語系等使用者偏好
      resetAll: () => {
        set({ characters: {}, activeVariant: {}, customVariants: {} });
      },

      setFilterMode: (mode) => set({ filterMode: mode }),
      setSearch: (text) => set({ search: text }),
      setRarityFilter: (rarities) => set({ rarityFilter: rarities }),
      setUserId: (id) => set({ userId: id }),
      setDisplayLang: (lang) => set({ displayLang: lang, langChosen: true }),
      setActiveVariant: (id, variantId) =>
        set((state) => ({
          activeVariant: { ...state.activeVariant, [id]: variantId },
          customVariants: { ...state.customVariants, [id]: true },
        })),
      setShowFutureSight: (showFutureSight) =>
        set((state) =>
          reconcileBox(
            {
              characters: state.characters,
              activeVariant: state.activeVariant,
              customVariants: state.customVariants,
              defaultSkinMode: state.defaultSkinMode,
              showFutureSight,
            },
            characters
          )
        ),
      setSkinMode: (mode) =>
        set((state) => {
          const nextVariant = { ...state.activeVariant };
          for (const character of characters) {
            if (state.customVariants[character.id]) continue;
            nextVariant[character.id] = resolveModeVariant(character, mode);
          }
          return { defaultSkinMode: mode, activeVariant: nextVariant };
        }),
      importBox: (payload) => {
        set(reconcileBox(payload, characters));
      },
    }),
    {
      name: "reverse1999-box-state",
      version: 9,
      partialize: partializeBoxStore,
      migrate: (persisted, version) => migratePersisted(persisted, version),
      merge: (persisted, current) =>
        persisted === undefined
          ? current
          : {
              ...current,
              ...(migratePersisted(persisted, 9) as PersistedBoxSnapshot),
            },
      storage: createJSONStorage(() => createSafeStorage()),
    }
  )
);

/** 取得單一角色的狀態（未持有時回傳空狀態） */
export function getCharacterState(
  state: BoxStore,
  id: string
): CharacterState {
  return state.characters[id] ?? emptyState;
}
