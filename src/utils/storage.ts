/** localStorage 安全讀寫 helper */

/** 儲存失敗事件名（App 監聽後顯示警告） */
export const STORAGE_ERROR_EVENT = "r1999:storage-error";

/** 曾發生過儲存失敗（module flag，App mount 時補救早期遺失的事件） */
let hasFailed = false;

function markStorageError(): void {
  hasFailed = true;
  window.dispatchEvent(new Event(STORAGE_ERROR_EVENT));
}

/** App mount 時檢查：若早期寫入已失敗（事件在 listener 註冊前發生），回傳 true 讓 App 顯示警告 */
export function consumeStorageError(): boolean {
  const failed = hasFailed;
  hasFailed = false;
  return failed;
}

export function loadJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn("[storage] 儲存失敗（可能為 localStorage 額滿或禁用）:", err);
    markStorageError();
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (err) {
    console.warn("[storage] 移除失敗:", err);
    markStorageError();
  }
}
