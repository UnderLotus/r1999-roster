import { ImageDown, Search, UserCheck, UserX, Users } from "lucide-react";

import type { FilterMode, LangCode } from "../store/boxStore";
import { getUiText } from "../i18n/ui";

interface ControlBarProps {
  search: string;
  filterMode: FilterMode;
  rarityFilter: number[];
  lang: LangCode;
  exportStatus: "idle" | "exporting" | "error";
  exportProgress: { loaded: number; total: number } | null;
  userId: string;
  onSearchChange: (text: string) => void;
  onFilterChange: (mode: FilterMode) => void;
  onRarityFilterChange: (rarities: number[]) => void;
  onUserIdChange: (id: string) => void;
  onExport: () => void;
}

export function ControlBar({
  search,
  filterMode,
  rarityFilter,
  lang,
  exportStatus,
  exportProgress,
  userId,
  onSearchChange,
  onFilterChange,
  onRarityFilterChange,
  onUserIdChange,
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

      <input
        type="text"
        className="search-field"
        value={userId}
        onChange={(event) => onUserIdChange(event.target.value)}
        placeholder={t.userIdPlaceholder}
        maxLength={20}
        style={{ maxWidth: 160 }}
      />

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

      <div className="control-bar__rarity-row">
        <div className="segmented-control" role="group" aria-label={t.rarityFilterLabel}>
          {[6, 5, 4, 3, 2].map((rarity) => {
            const active = rarityFilter.includes(rarity);
            return (
              <button
                key={rarity}
                type="button"
                data-active={active}
                aria-pressed={active}
                onClick={() => {
                  if (active) {
                    onRarityFilterChange(rarityFilter.filter((r) => r !== rarity));
                  } else {
                    onRarityFilterChange([...rarityFilter, rarity]);
                  }
                }}
              >
                ★{rarity}
              </button>
            );
          })}
        </div>
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
          {exportStatus === "exporting" && exportProgress
            ? `${t.exporting} (${exportProgress.loaded}/${exportProgress.total})`
            : exportStatus === "exporting"
              ? t.exporting
              : t.export}
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
