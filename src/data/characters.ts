import type { Character } from "../types/character";

import charactersJson from "./characters.json";

function validateCharacter(c: unknown): c is Character {
  if (!c || typeof c !== "object") return false;
  const ch = c as Record<string, unknown>;
  return (
    typeof ch.id === "string" &&
    typeof ch.name === "string" &&
    typeof ch.baseId === "number" &&
    typeof ch.releaseOrder === "number" &&
    Array.isArray(ch.skins) &&
    typeof ch.defaultVariant === "string"
  );
}

/** 全部角色，依 releaseOrder 排序、過濾 enabled */
export const characters: Character[] = (charactersJson as Character[])
  .filter((c) => validateCharacter(c) && c.enabled)
  .sort((a, b) => a.releaseOrder - b.releaseOrder);

const byId = new Map(characters.map((c) => [c.id, c]));

if (byId.size !== characters.length) {
  throw new Error("characters.json 有重複的 id");
}

export function getCharacterById(id: string): Character | undefined {
  return byId.get(id);
}
