import type { Character, CharacterState } from "../types/character";
import type { LangCode } from "../store/boxStore";
import { CharacterCard } from "./CharacterCard";
import { EmptyState } from "./EmptyState";

/** 未持有角色的共用空狀態（避免每次 render 建立新物件破壞 memo） */
const EMPTY_STATE: CharacterState = { owned: false, portray: 0 };

interface CharacterGridProps {
  characters: Character[];
  states: Record<string, CharacterState>;
  lang: LangCode;
  activeVariant: Record<string, string>;
  showFutureSight: boolean;

  onActivate: (id: string) => void;
  onDecrease: (id: string) => void;
  onSkinSelect: (id: string, variantId: string) => void;
}

export function CharacterGrid({
  characters,
  states,
  lang,
  activeVariant,
  showFutureSight,
  onActivate,
  onDecrease,
  onSkinSelect,
}: CharacterGridProps) {
  if (characters.length === 0) {
    return <EmptyState lang={lang} />;
  }

  return (
    <div className="character-grid">
      {characters.map((character) => (
        <CharacterCard
          key={character.id}
          character={character}
          state={states[character.id] ?? EMPTY_STATE}
          lang={lang}
          activeVariant={
            activeVariant[character.id] ?? character.defaultVariant
          }
          onActivate={onActivate}
          onDecrease={onDecrease}
          onSkinSelect={onSkinSelect}
          showFutureSight={showFutureSight}
        />
      ))}
    </div>
  );
}
