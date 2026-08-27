import type { StateStorage } from "zustand/middleware";

/** 儲存失敗事件名（App 監聽後顯示警告） */
export const STORAGE_ERROR_EVENT = "r1999:storage-error";

/** 曾發生過儲存失敗（module flag，App mount 時補救早期遺失的事件） */
let hasFailed = false;

function markStorageError(): void {
  hasFailed = true;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(STORAGE_ERROR_EVENT));
}

function reportStorageError(message: string, error?: unknown): void {
  markStorageError();
  console.warn(message, error);
}

/** App mount 時檢查：若早期寫入已失敗，回傳 true 讓 App 顯示警告。 */
export function consumeStorageError(): boolean {
  const failed = hasFailed;
  hasFailed = false;
  return failed;
}

interface RawStringStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): RawStringStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

function isPersistedEnvelope(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const envelope = value as Record<string, unknown>;
  if (!("state" in envelope)) return false;
  if (
    typeof envelope.state !== "object" ||
    envelope.state === null ||
    Array.isArray(envelope.state)
  ) {
    return false;
  }
  return (
    envelope.version === undefined ||
    (typeof envelope.version === "number" && Number.isFinite(envelope.version))
  );
}

function canonicalPersistedString(raw: string): {
  value: string;
  legacy: boolean;
} | null {
  let outer: unknown;
  try {
    outer = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  if (typeof outer === "string") {
    let inner: unknown;
    try {
      inner = JSON.parse(outer) as unknown;
    } catch {
      return null;
    }
    return isPersistedEnvelope(inner) ? { value: outer, legacy: true } : null;
  }

  return isPersistedEnvelope(outer) ? { value: raw, legacy: false } : null;
}

/**
 * Raw Zustand StateStorage. Canonical strings pass through unchanged. The
 * previous Roster format stored that string as JSON once more; valid legacy
 * values are unwrapped and rewritten best-effort during first hydration.
 */
export function createSafeStorage(
  suppliedStorage?: RawStringStorage | null
): StateStorage {
  const resolveStorage = (): RawStringStorage | null =>
    suppliedStorage === undefined ? browserStorage() : suppliedStorage;

  return {
    getItem(key) {
      let raw: string | null;
      let storage: RawStringStorage | null;
      try {
        storage = resolveStorage();
        if (!storage) return null;
        raw = storage.getItem(key);
      } catch {
        return null;
      }
      if (raw === null) return null;

      const canonical = canonicalPersistedString(raw);
      if (!canonical) return null;
      if (canonical.legacy) {
        try {
          storage.setItem(key, canonical.value);
        } catch (error) {
          reportStorageError("[storage] legacy persist rewrite failed", error);
        }
      }
      return canonical.value;
    },
    setItem(key, value) {
      try {
        const storage = resolveStorage();
        if (!storage) {
          reportStorageError("[storage] persist unavailable");
          return;
        }
        storage.setItem(key, value);
      } catch (error) {
        reportStorageError("[storage] persist failed", error);
      }
    },
    removeItem(key) {
      try {
        const storage = resolveStorage();
        if (!storage) {
          reportStorageError("[storage] persist remove unavailable");
          return;
        }
        storage.removeItem(key);
      } catch (error) {
        reportStorageError("[storage] persist remove failed", error);
      }
    },
  };
}
