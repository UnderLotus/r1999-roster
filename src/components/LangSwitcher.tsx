import { LANGS } from "../utils/i18n";
import { getUiText } from "../i18n/ui";
import type { LangCode } from "../store/boxStore";

interface LangSwitcherProps {
  value: LangCode;
  onChange: (lang: LangCode) => void;
}

/** 語系切換按鈕（CN/TW/EN/JP/KR），位於頁面左上角 */
export function LangSwitcher({ value, onChange }: LangSwitcherProps) {
  const t = getUiText(value);

  return (
    <div className="lang-switcher" role="group" aria-label={t.langSwitcherLabel}>
      {LANGS.map(({ code, label }) => (
        <button
          key={code}
          type="button"
          data-active={value === code}
          onClick={() => onChange(code)}
          aria-pressed={value === code}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
