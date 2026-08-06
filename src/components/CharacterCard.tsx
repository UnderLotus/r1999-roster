import type { Character, CharacterState } from "../types/character";
import type { LangCode } from "../store/boxStore";
import { getDisplayName } from "../utils/i18n";
import { CharacterImage } from "./CharacterImage";
import { CharacterQuickActions } from "./CharacterQuickActions";
import { PortrayBadge } from "./PortrayBadge";

interface CharacterCardProps {
  character: Character;
  state: CharacterState;
  lang: LangCode;

  onActivate: (id: string) => void;
  onDecrease: (id: string) => void;
  onRemove: (id: string) => void;
}

export function CharacterCard({
  character,
  state,
  lang,
  onActivate,
  onDecrease,
  onRemove,
}: CharacterCardProps) {
  const displayName = getDisplayName(character, lang);

  return (
    <article
      className="character-card"
      data-owned={state.owned}
      data-portray={state.portray}
    >
      <button
        type="button"
        className="character-card__main"
        onClick={() => onActivate(character.id)}
      >
        <span className="character-card__image-area">
          <span className="character-card__image-frame">
            <CharacterImage character={character} lang={lang} />
          </span>
          <PortrayBadge level={state.portray} lang={lang} />
        </span>
        <span className="character-card__name">{displayName}</span>
      </button>

      {state.owned && (
        <CharacterQuickActions
          name={displayName}
          lang={lang}
          onDecrease={() => onDecrease(character.id)}
          onRemove={() => onRemove(character.id)}
        />
      )}
    </article>
  );
}
