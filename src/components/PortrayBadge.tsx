import type { LangCode } from "../store/boxStore";
import { getUiText } from "../i18n/ui";

interface PortrayBadgeProps {
  level: number;
  lang: LangCode;
  /** bottom：貼圖片底部（匯出用）；預設：名字上方（網頁用） */
  position?: "default" | "bottom";
}

export function PortrayBadge({ level, lang, position = "default" }: PortrayBadgeProps) {
  if (level <= 0) return null;

  const t = getUiText(lang);

  return (
    <span
      className={`portray-badge portray-badge--${position}`}
      aria-label={t.portrayLabel(level)}
    >
      {level}
      <small>{t.portrayUnit}</small>
    </span>
  );
}
