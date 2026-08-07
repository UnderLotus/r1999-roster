import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { CharacterState, PortrayLevel } from "../types/character";
import { loadJSON, removeKey, saveJSON } from "../utils/storage";

export type FilterMode = "all" | "owned" | "unowned";
export type LangCode = "zh-CN" | "zh-TW" | "en-US" | "ja-JP" | "ko-KR";

export interface BoxStore {
  characters: Record<string, CharacterState>;
  activeVariant: Record<string, string>;
  filterMode: FilterMode;
  search: string;
  displayLang: LangCode;

  activateCharacter: (id: string) => void;
  decreasePortray: (id: string) => void;
  removeCharacter: (id: string) => void;
  resetAll: () => void;
  setFilterMode: (mode: FilterMode) => void;
  setSearch: (text: string) => void;
  setDisplayLang: (lang: LangCode) => void;
  setActiveVariant: (id: string, variantId: string) => void;
}

const emptyState: CharacterState = { owned: false, portray: 0 };

/* ---------- 持久化資料清理（localStorage 為不可信資料） ---------- */

export interface PersistedBoxState {
  characters?: Record<string, CharacterState>;
  displayLang?: unknown;
  activeVariant?: unknown;
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
      filterMode: "all",
      search: "",
      displayLang: "en-US",

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
            delete next[id];
            delete nextVariant[id];
            return { characters: next, activeVariant: nextVariant };
          });
        }
      },

      removeCharacter: (id) => {
        set((state) => {
          const next = { ...state.characters };
          const nextVariant = { ...state.activeVariant };
          delete next[id];
          delete nextVariant[id];
          return { characters: next, activeVariant: nextVariant };
        });
      },

      resetAll: () => {
        set({ characters: {}, activeVariant: {} });
      },

      setFilterMode: (mode) => set({ filterMode: mode }),
      setSearch: (text) => set({ search: text }),
      setDisplayLang: (lang) => set({ displayLang: lang }),
      setActiveVariant: (id, variantId) =>
        set((state) => ({
          activeVariant: { ...state.activeVariant, [id]: variantId },
        })),
    }),
    {
      name: "reverse1999-box-state",
      version: 5,
      partialize: (state) => ({
        characters: state.characters,
        displayLang: state.displayLang,
        activeVariant: state.activeVariant,
      }),
      migrate: (persisted, version) => {
        const migrated = migratePersistedState(persisted);

        // v4 → v5: old skinMode global toggle is deprecated.
        // activeVariant starts empty; App.tsx fills defaults from
        // characters.defaultVariant on first load.
        // Old skinMode: "insight" matches new default (02).
        // Old skinMode: "default" is lost (per-char variant is now the model).
        return {
          characters: migrated.characters,
          displayLang: migrated.displayLang,
          activeVariant: version && version >= 5
            ? migrated.activeVariant
            : {},
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
