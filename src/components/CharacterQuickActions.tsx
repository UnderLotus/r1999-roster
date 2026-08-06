import { Minus, X } from "lucide-react";

import type { LangCode } from "../store/boxStore";
import { getUiText } from "../i18n/ui";

interface CharacterQuickActionsProps {
  name: string;
  lang: LangCode;
  onDecrease: () => void;
  onRemove: () => void;
}

export function CharacterQuickActions({
  name,
  lang,
  onDecrease,
  onRemove,
}: CharacterQuickActionsProps) {
  const t = getUiText(lang);

  return (
    <div className="character-card__actions">
      <button
        type="button"
        className="character-action character-action--decrease"
        aria-label={t.decreasePortray(name)}
        onClick={(event) => {
          event.stopPropagation();
          onDecrease();
        }}
      >
        <Minus size={14} strokeWidth={2} />
      </button>

      <button
        type="button"
        className="character-action character-action--remove"
        aria-label={t.removeCharacter(name)}
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
