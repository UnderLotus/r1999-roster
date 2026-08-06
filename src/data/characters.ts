import type { Character } from "../types/character";

import charactersJson from "./characters.json";

/** 全部角色，依 releaseOrder 排序、過濾 enabled */
export const characters: Character[] = (charactersJson as Character[])
  .filter((c) => c.enabled)
  .sort((a, b) => a.releaseOrder - b.releaseOrder);

const byId = new Map(characters.map((c) => [c.id, c]));

// 開發期檢查：重複 ID 表示資料有問題，直接失敗
if (byId.size !== characters.length) {
  throw new Error("characters.json 有重複的 id");
}

export function getCharacterById(id: string): Character | undefined {
  return byId.get(id);
}
