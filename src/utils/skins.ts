import type { Character } from "../types/character";
import type { SkinMode } from "../domain/box";

/** 依 skin 模式解析角色預設 variant（insight 缺 02 時 fallback 01） */
export function resolveModeVariant(
  character: Character,
  mode: SkinMode
): string {
  if (mode === "insight") {
    const insight = character.skins.find((s) => s.type === "insight");
    if (insight) return insight.variantId;
  }
  return `${character.baseId}01`;
}