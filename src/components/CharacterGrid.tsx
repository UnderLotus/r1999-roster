import type { Character, CharacterState } from "../types/character";
import type { LangCode } from "../store/boxStore";
import { CharacterCard } from "./CharacterCard";
import { EmptyState } from "./EmptyState";

import type { SkinMode } from "../store/boxStore";

interface CharacterGridProps {
  characters: Character[];
  states: Record<string, CharacterState>;
  lang: LangCode;
  skinMode: SkinMode;

  onActivate: (id: string) => void;
  onDecrease: (id: string) => void;
  onRemove: (id: string) => void;
}

export function CharacterGrid({
  characters,
  states,
  lang,
  skinMode,
  onActivate,
  onDecrease,
  onRemove,
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
          skinMode={skinMode}
          onActivate={onActivate}
          onDecrease={onDecrease}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}
