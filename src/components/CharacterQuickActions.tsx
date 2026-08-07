import { Minus } from "lucide-react";

import type { LangCode } from "../store/boxStore";
import { getUiText } from "../i18n/ui";

interface CharacterQuickActionsProps {
  name: string;
  lang: LangCode;
  onDecrease: () => void;
}

export function CharacterQuickActions({
  name,
  lang,
  onDecrease,
}: CharacterQuickActionsProps) {
  const t = getUiText(lang);

  return (
    <button
      type="button"
      className="character-action character-action--decrease"
      aria-label={t.decreasePortray(name)}
      title={t.decreasePortray(name)}
      onClick={(event) => {
        event.stopPropagation();
        onDecrease();
      }}
    >
      <Minus size={14} strokeWidth={2} />
    </button>
  );
}
