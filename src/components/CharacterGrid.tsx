import type { Character, CharacterState } from "../types/character";
import type { LangCode } from "../store/boxStore";
import { CharacterCard } from "./CharacterCard";
import { EmptyState } from "./EmptyState";

interface CharacterGridProps {
  characters: Character[];
  states: Record<string, CharacterState>;
  lang: LangCode;
  activeVariant: Record<string, string>;

  onActivate: (id: string) => void;
  onDecrease: (id: string) => void;
  onSkinSelect: (id: string, variantId: string) => void;
}

export function CharacterGrid({
  characters,
  states,
  lang,
  activeVariant,
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
          state={states[character.id] ?? { owned: false, portray: 0 }}
          lang={lang}
          activeVariant={
            activeVariant[character.id] ?? character.defaultVariant
          }
          onActivate={onActivate}
          onDecrease={onDecrease}
          onSkinSelect={onSkinSelect}
        />
      ))}
    </div>
  );
}
