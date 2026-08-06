import { useState } from "react";

import type { Character } from "../types/character";
import type { LangCode } from "../store/boxStore";
import { getUiText } from "../i18n/ui";

interface CharacterImageProps {
  character: Character;
  lang: LangCode;
}

export function CharacterImage({ character, lang }: CharacterImageProps) {
  const [hasError, setHasError] = useState(false);
  const t = getUiText(lang);

  if (hasError) {
    return (
      <div
        className="character-card__image character-card__image--error"
        role="img"
        aria-label={t.imageErrorLabel(character.name)}
      >
        {t.imageError}
      </div>
    );
  }

  return (
    <img
      className="character-card__image"
      src={import.meta.env.BASE_URL + character.images.avatar.replace(/^\//, "")}
      alt={character.name}
      loading="lazy"
      decoding="async"
      onError={() => setHasError(true)}
      style={
        character.avatarPosition
          ? {
              objectPosition: `${character.avatarPosition.x}% ${character.avatarPosition.y}%`,
            }
          : undefined
      }
    />
  );
}
