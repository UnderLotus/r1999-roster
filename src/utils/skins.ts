import { resolveCharacterVariant } from "../domain/variant-identity";
import type { Character } from "../types/character";
import type { SkinMode } from "../domain/box";

/** 依角色明確的 default/insight metadata 解析預設 variant。 */
export function resolveModeVariant(
  character: Character,
  mode: SkinMode
): string {
  return resolveCharacterVariant(character, mode);
}
