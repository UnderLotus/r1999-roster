import type { LangCode } from "../store/boxStore";
import { getUiText } from "../i18n/ui";

interface PortrayBadgeProps {
  level: number;
  lang: LangCode;
  /** bottom：貼圖片底部（匯出用）；預設：名字上方（網頁用） */
  position?: "default" | "bottom";
}

const SEGMENTS = 5;

/** 塑造顯示：五段細長孔（底片齒孔風格），依 level 由左至右亮起 */
export function PortrayBadge({ level, lang, position = "default" }: PortrayBadgeProps) {
  if (level <= 0) return null;

  const t = getUiText(lang);

  return (
    <span
      className={`portray-badge portray-badge--${position}`}
      role="img"
      aria-label={t.portrayLabel(level)}
    >
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <span
          key={i}
          className="portray-badge__segment"
          data-filled={i < level}
        />
      ))}
    </span>
  );
}
