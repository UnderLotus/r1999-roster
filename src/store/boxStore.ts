import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { CharacterState, PortrayLevel } from "../types/character";
import { loadJSON, removeKey, saveJSON } from "../utils/storage";

export type FilterMode = "all" | "owned" | "unowned";
export type LangCode = "zh-CN" | "zh-TW" | "en-US" | "ja-JP" | "ko-KR";
export type SkinMode = "default" | "insight";

export interface BoxStore {
  characters: Record<string, CharacterState>;
  filterMode: FilterMode;
  search: string;
  displayLang: LangCode;
  skinMode: SkinMode;

  activateCharacter: (id: string) => void;
  decreasePortray: (id: string) => void;
  removeCharacter: (id: string) => void;
  resetAll: () => void;
  setFilterMode: (mode: FilterMode) => void;
  setSearch: (text: string) => void;
  setDisplayLang: (lang: LangCode) => void;
  setSkinMode: (mode: SkinMode) => void;
}

const emptyState: CharacterState = { owned: false, portray: 0 };

/* ---------- 持久化資料清理（localStorage 為不可信資料） ---------- */

export interface PersistedBoxState {
  characters?: Record<string, CharacterState>;
  displayLang?: unknown;
  skinMode?: unknown;
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

function normalizeSkinMode(value: unknown): SkinMode {
  return value === "insight" ? "insight" : "default";
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

/** 清理持久化狀態：owned 嚴格 true、portray 限 0~5 整數；未持有項目不保留 */
export function migratePersistedState(raw: unknown): PersistedBoxState {
  const data = isRecord(raw) ? raw : {};
  const rawCharacters = isRecord(data.characters) ? data.characters : {};

  const characters: Record<string, CharacterState> = {};
  for (const [id, state] of Object.entries(rawCharacters)) {
    if (!isRecord(state)) continue;
    const owned = state.owned === true; // 只有真正的 true 才算持有
    if (!owned) continue; // 未持有角色不存入 characters
    characters[id] = { owned: true, portray: normalizePortray(state.portray) };
  }

  return {
    characters,
    displayLang: normalizeDisplayLang(data.displayLang),
    skinMode: normalizeSkinMode(data.skinMode),
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
      filterMode: "all",
      search: "",
      displayLang: "en-US",
      skinMode: "insight",

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
        // 5 塑後再次點擊維持 5 塑，不循環
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
          // 0 塑再按 − → 取消持有
          set((state) => {
            const next = { ...state.characters };
            delete next[id];
            return { characters: next };
          });
        }
      },

      // 未持有角色不存入 characters（讀取時由 getCharacterState 視為空狀態）
      removeCharacter: (id) => {
        set((state) => {
          const next = { ...state.characters };
          delete next[id];
          return { characters: next };
        });
      },

      resetAll: () => {
        set({ characters: {} });
      },

      setFilterMode: (mode) => set({ filterMode: mode }),
      setSearch: (text) => set({ search: text }),
      setDisplayLang: (lang) => set({ displayLang: lang }),
      setSkinMode: (mode) => set({ skinMode: mode }),
    }),
    {
      name: "reverse1999-box-state",
      version: 3,
      // 持久化收藏狀態 + 語系偏好；不存瀏覽情境（搜尋/篩選）
      partialize: (state) => ({
        characters: state.characters,
        displayLang: state.displayLang,
        skinMode: state.skinMode,
      }),
      migrate: (persisted) => {
        const { characters, displayLang, skinMode } = migratePersistedState(persisted);
        return { characters, displayLang, skinMode };
      },
      // 用安全 storage helper 取代預設 localStorage 直接操作
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
