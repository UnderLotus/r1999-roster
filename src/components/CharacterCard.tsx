import { useState } from "react";

import type { Character, CharacterState } from "../types/character";
import type { LangCode } from "../store/boxStore";
import { getDisplayName } from "../utils/i18n";
import { CharacterImage } from "./CharacterImage";
import { CharacterQuickActions } from "./CharacterQuickActions";
import { PortrayBadge } from "./PortrayBadge";
import { SkinPicker, SkinPickerTrigger } from "./SkinPicker";

interface CharacterCardProps {
  character: Character;
  state: CharacterState;
  lang: LangCode;
  activeVariant: string;

  onActivate: (id: string) => void;
  onDecrease: (id: string) => void;
  onSkinSelect: (id: string, variantId: string) => void;
}

export function CharacterCard({
  character,
  state,
  lang,
  activeVariant,
  onActivate,
  onDecrease,
  onSkinSelect,
}: CharacterCardProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
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
            <CharacterImage
              key={activeVariant}
              character={character}
              lang={lang}
              variantId={activeVariant}
            />
          </span>
          <PortrayBadge level={state.portray} lang={lang} />
        </span>
        <span className="character-card__name">{displayName}</span>
      </button>

      {state.owned && (
        <>
          <CharacterQuickActions
            name={displayName}
            lang={lang}
            onDecrease={() => onDecrease(character.id)}
          />
          <SkinPickerTrigger onClick={() => setPickerOpen(true)} />
          {pickerOpen && (
            <SkinPicker
              character={character}
              activeVariant={activeVariant}
              onSelect={(variantId) =>
                onSkinSelect(character.id, variantId)
              }
              onClose={() => setPickerOpen(false)}
            />
          )}
        </>
      )}
    </article>
  );
}
