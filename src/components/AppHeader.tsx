import type { CharacterState } from "../types/character";
import type { LangCode } from "../store/boxStore";
import { characters } from "../data/characters";
import { getUiText } from "../i18n/ui";

interface AppHeaderProps {
  total: number;
  states: Record<string, CharacterState>;
  lang: LangCode;
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="app-header__summary-item">
      <span className="app-header__summary-label">{label}</span>
      <span className="app-header__summary-value">{value}</span>
    </div>
  );
}

export function AppHeader({ total, states, lang }: AppHeaderProps) {
  const t = getUiText(lang);

  // 只統計目前角色清單內的持有（防 localStorage 殘留未知 ID 污染統計）
  const owned = characters.filter((c) => states[c.id]?.owned).length;
  const fullPortray = characters.filter(
    (c) => states[c.id]?.owned && states[c.id]?.portray === 5
  ).length;

  return (
    <header className="app-header">
      <div className="app-header__title">
        <span className="app-header__eyebrow">{t.eyebrow}</span>
        <h1>{t.appTitle}</h1>
      </div>

      <div className="app-header__summary" aria-live="polite">
        <SummaryItem label={t.owned} value={`${owned} / ${total}`} />
        <SummaryItem label={t.fullPortray} value={`${fullPortray}`} />
      </div>
    </header>
  );
}
