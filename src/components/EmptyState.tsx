import { SearchX } from "lucide-react";

import type { LangCode } from "../store/boxStore";
import { getUiText } from "../i18n/ui";

/** 搜尋/篩選無結果的空狀態（spec §22） */
export function EmptyState({ lang }: { lang: LangCode }) {
  const t = getUiText(lang);

  return (
    <div className="empty-state">
      <SearchX size={24} />
      <strong>{t.emptyTitle}</strong>
      <span>{t.emptyHint}</span>
    </div>
  );
}
