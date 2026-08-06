import { ImageDown, Search, UserCheck, UserX, Users } from "lucide-react";

import type { FilterMode, LangCode } from "../store/boxStore";
import { getUiText } from "../i18n/ui";

interface ControlBarProps {
  search: string;
  filterMode: FilterMode;
  lang: LangCode;
  exportStatus: "idle" | "exporting" | "error";
  onSearchChange: (text: string) => void;
  onFilterChange: (mode: FilterMode) => void;
  onExport: () => void;
}

export function ControlBar({
  search,
  filterMode,
  lang,
  exportStatus,
  onSearchChange,
  onFilterChange,
  onExport,
}: ControlBarProps) {
  const t = getUiText(lang);

  const filters = [
    { mode: "all" as FilterMode, label: t.filterAll, icon: Users },
    { mode: "owned" as FilterMode, label: t.filterOwned, icon: UserCheck },
    { mode: "unowned" as FilterMode, label: t.filterUnowned, icon: UserX },
  ];

  return (
    <div className="control-bar">
      <div className="search-field">
        <Search size={15} />
        <input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t.searchPlaceholder}
          aria-label={t.searchLabel}
        />
      </div>

      <div className="segmented-control" role="group" aria-label={t.filterLabel}>
        {filters.map(({ mode, label, icon: Icon }) => (
          <button
            key={mode}
            type="button"
            data-active={filterMode === mode}
            aria-pressed={filterMode === mode}
            onClick={() => onFilterChange(mode)}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>

      <div className="control-bar__spacer" />

      <div className="control-bar__export">
        <button
          type="button"
          className="button button--primary"
          onClick={onExport}
          disabled={exportStatus === "exporting"}
        >
          <ImageDown size={15} />
          {exportStatus === "exporting" ? t.exporting : t.export}
        </button>
        {exportStatus === "error" && (
          <span className="control-bar__export-error" role="alert">
            {t.exportError}
          </span>
        )}
      </div>
    </div>
  );
}
