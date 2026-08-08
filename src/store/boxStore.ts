import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { characters } from "../data/characters";
import type { CharacterState, PortrayLevel } from "../types/character";
import { resolveModeVariant } from "../utils/skins";
import { loadJSON, removeKey, saveJSON } from "../utils/storage";

export type FilterMode = "all" | "owned" | "unowned";
export type LangCode = "zh-CN" | "zh-TW" | "en-US" | "ja-JP" | "ko-KR";
export type SkinMode = "initial" | "insight";

export interface BoxStore {
  characters: Record<string, CharacterState>;
  activeVariant: Record<string, string>;
  customVariants: Record<string, true>;
  filterMode: FilterMode;
  search: string;
  rarityFilter: number[];
  userId: string;
  displayLang: LangCode;
  showFutureSight: boolean;
  defaultSkinMode: SkinMode;

  activateCharacter: (id: string) => void;
  decreasePortray: (id: string) => void;
  removeCharacter: (id: string) => void;
  resetAll: () => void;
  setFilterMode: (mode: FilterMode) => void;
  setSearch: (text: string) => void;
  setRarityFilter: (rarities: number[]) => void;
  setUserId: (id: string) => void;
  setDisplayLang: (lang: LangCode) => void;
  setActiveVariant: (id: string, variantId: string) => void;
  setShowFutureSight: (v: boolean) => void;
  setSkinMode: (mode: SkinMode) => void;
}

const emptyState: CharacterState = { owned: false, portray: 0 };

/* ---------- 持久化資料清理（localStorage 為不可信資料） ---------- */

export interface PersistedBoxState {
  characters?: Record<string, CharacterState>;
  displayLang?: unknown;
  activeVariant?: unknown;
  customVariants?: unknown;
  userId?: unknown;
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

function normalizePortray(value: unknown): PortrayLevel {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value)
  ) {
    return 0;
  }
  return Math.min(5, Math.max(0, value)) as PortrayLevel;
}

function normalizeUserId(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 100) : "";
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeActiveVariant(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && v.length > 0) {
      result[k] = v;
    }
  }
  return result;
}

function normalizeCustomVariants(value: unknown): Record<string, true> {
  if (!isRecord(value)) return {};
  const result: Record<string, true> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === true) {
      result[k] = true;
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
    characters[id] = { owned: true, portray: normalizePortray(state.portray) };
  }

  return {
    characters,
    displayLang: normalizeDisplayLang(data.displayLang),
    activeVariant: normalizeActiveVariant(data.activeVariant),
    customVariants: normalizeCustomVariants(data.customVariants),
    userId: normalizeUserId(data.userId),
    showFutureSight: normalizeBoolean(data.showFutureSight),
    defaultSkinMode: normalizeSkinMode(data.defaultSkinMode),
  };
}

/* ---------- store ---------- */

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

      removeCharacter: (id) => {
        set((state) => {
          const next = { ...state.characters };
          const nextVariant = { ...state.activeVariant };
          const nextCustom = { ...state.customVariants };
          delete next[id];
          delete nextVariant[id];
          delete nextCustom[id];
          return { characters: next, activeVariant: nextVariant, customVariants: nextCustom };
        });
      },

      // 只重置角色資料；保留 userId、過濾、語系等使用者偏好
      resetAll: () => {
        set({ characters: {}, activeVariant: {}, customVariants: {} });
      },

      setFilterMode: (mode) => set({ filterMode: mode }),
      setSearch: (text) => set({ search: text }),
      setRarityFilter: (rarities) => set({ rarityFilter: rarities }),
      setUserId: (id) => set({ userId: id }),
      setDisplayLang: (lang) => set({ displayLang: lang }),
      setActiveVariant: (id, variantId) =>
        set((state) => ({
          activeVariant: { ...state.activeVariant, [id]: variantId },
          customVariants: { ...state.customVariants, [id]: true },
        })),
      setShowFutureSight: (v) => set({ showFutureSight: v }),
      setSkinMode: (mode) =>
        set((state) => {
          const nextVariant = { ...state.activeVariant };
          for (const character of characters) {
            if (state.customVariants[character.id]) continue;
            nextVariant[character.id] = resolveModeVariant(character, mode);
          }
          return { defaultSkinMode: mode, activeVariant: nextVariant };
        }),
    }),
    {
      name: "reverse1999-box-state",
      version: 6,
      partialize: (state) => ({
        characters: state.characters,
        displayLang: state.displayLang,
        activeVariant: state.activeVariant,
        customVariants: state.customVariants,
        userId: state.userId,
        showFutureSight: state.showFutureSight,
        defaultSkinMode: state.defaultSkinMode,
      }),
      migrate: (persisted, version) => {
        const migrated = migratePersistedState(persisted);

        // v5 → v6: 預設立繪改為初始（01）。舊資料的 activeVariant
        // 全是 02（舊預設），重設為 {} 讓 App.tsx 依 defaultSkinMode
        // 重新填充為 01。
        if (version && version >= 6) {
          return {
            characters: migrated.characters,
            displayLang: migrated.displayLang,
            activeVariant: migrated.activeVariant,
            customVariants: migrated.customVariants,
            userId: migrated.userId ?? "",
            showFutureSight: migrated.showFutureSight ?? false,
            defaultSkinMode: migrated.defaultSkinMode ?? "initial",
          };
        }
        return {
          characters: migrated.characters,
          displayLang: migrated.displayLang,
          activeVariant: {},
          customVariants: {},
          userId: migrated.userId ?? "",
          showFutureSight: migrated.showFutureSight ?? false,
          defaultSkinMode: "initial",
        };
      },
      storage: createJSONStorage(() => ({
        getItem: (key) => loadJSON<string>(key),
        setItem: (key, value) => saveJSON(key, value),
        removeItem: (key) => removeKey(key),
      })),
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
