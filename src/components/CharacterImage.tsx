import { useState } from "react";

import type { Character } from "../types/character";
import type { LangCode, SkinMode } from "../store/boxStore";
import { getUiText } from "../i18n/ui";

interface CharacterImageProps {
  character: Character;
  lang: LangCode;
  skinMode: SkinMode;
}

export function CharacterImage({ character, lang, skinMode }: CharacterImageProps) {
  const [hasError, setHasError] = useState(false);
  const t = getUiText(lang);

  const src =
    skinMode === "insight" && character.images.insight
      ? import.meta.env.BASE_URL + character.images.insight.replace(/^\//, "")
      : import.meta.env.BASE_URL + character.images.avatar.replace(/^\//, "");

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
      src={src}
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
