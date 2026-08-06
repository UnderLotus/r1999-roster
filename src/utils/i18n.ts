import type { Character } from "../types/character";
import type { LangCode } from "../store/boxStore";

export const LANGS: { code: LangCode; label: string }[] = [
  { code: "zh-CN", label: "CN" },
  { code: "zh-TW", label: "TW" },
  { code: "en-US", label: "EN" },
  { code: "ja-JP", label: "JP" },
  { code: "ko-KR", label: "KR" },
];

/**
 * 取得角色的顯示名稱（fallback 規則）：
 * 目前語系 → 英文 → 簡中 → name
 */
export function getDisplayName(character: Character, lang: LangCode): string {
  const names = character.names;
  if (!names) return character.name;

  return names[lang] ?? names["en-US"] ?? names["zh-CN"] ?? character.name;
}

/** 角色所有語系名稱的集合（用於跨語系搜尋） */
export function getAllNames(character: Character): string[] {
  const set = new Set<string>([character.name]);
  for (const value of Object.values(character.names ?? {})) {
    if (value) set.add(value);
  }
  return [...set];
}
