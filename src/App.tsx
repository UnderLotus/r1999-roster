import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Sparkles } from "lucide-react";

import { AppHeader } from "./components/AppHeader";
import { CharacterGrid } from "./components/CharacterGrid";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ControlBar } from "./components/ControlBar";
import { ExportCanvas } from "./components/ExportCanvas";
import { LangSwitcher } from "./components/LangSwitcher";
import { characters } from "./data/characters";
import { getUiText } from "./i18n/ui";
import { useBoxStore } from "./store/boxStore";
import { exportJpeg } from "./utils/export-image";
import { getAllNames } from "./utils/i18n";
import "./styles/character-card.css";
import "./styles/app-header.css";
import "./styles/control-bar.css";
import "./styles/export-canvas.css";

type ExportStatus = "idle" | "exporting" | "error";

/** 專案儲存庫網址（頁尾顯示與連結） */
const REPO_URL = "https://github.com/UnderLotus/r1999-roster";

export default function App() {
  const states = useBoxStore((s) => s.characters);
  const filterMode = useBoxStore((s) => s.filterMode);
  const search = useBoxStore((s) => s.search);
  const displayLang = useBoxStore((s) => s.displayLang);
  const skinMode = useBoxStore((s) => s.skinMode);
  const setFilterMode = useBoxStore((s) => s.setFilterMode);
  const setSearch = useBoxStore((s) => s.setSearch);
  const setDisplayLang = useBoxStore((s) => s.setDisplayLang);
  const setSkinMode = useBoxStore((s) => s.setSkinMode);
  const activateCharacter = useBoxStore((s) => s.activateCharacter);
  const decreasePortray = useBoxStore((s) => s.decreasePortray);
  const removeCharacter = useBoxStore((s) => s.removeCharacter);
  const resetAll = useBoxStore((s) => s.resetAll);

  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const exportErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 匯出時的狀態快照（凍結，避免匯出期間資料變動）
  const [exportSnapshot, setExportSnapshot] = useState<{
    states: typeof states;
    lang: typeof displayLang;
    skinMode: typeof skinMode;
  } | null>(null);
  const exportLayerRef = useRef<HTMLDivElement>(null);
  const t = getUiText(displayLang);

  // 頁面 title 隨語系
  useEffect(() => {
    document.title = `${t.appTitle} — Reverse: 1999`;
  }, [t.appTitle]);

  // 卸載時清理匯出錯誤 timer
  useEffect(() => {
    return () => {
      if (exportErrorTimerRef.current) clearTimeout(exportErrorTimerRef.current);
    };
  }, []);

  const visibleCharacters = useMemo(() => {
    const query = search.trim().toLowerCase();
    return characters.filter((c) => {
      if (filterMode === "owned" && !states[c.id]?.owned) return false;
      if (filterMode === "unowned" && states[c.id]?.owned) return false;
      // 跨語系搜尋：任一語系名稱匹配即命中
      if (
        query &&
        !getAllNames(c).some((name) => name.toLowerCase().includes(query))
      ) {
        return false;
      }
      return true;
    });
  }, [states, filterMode, search]);

  const handleExport = async () => {
    if (exportStatus === "exporting" || !exportLayerRef.current) return;
    // 清除殘留的錯誤 timer（避免干擾本次匯出）
    if (exportErrorTimerRef.current) {
      clearTimeout(exportErrorTimerRef.current);
      exportErrorTimerRef.current = null;
    }
    // 凍結匯出快照（states + lang + skinMode），避免等待期間內容變動
    setExportSnapshot({ states: { ...states }, lang: displayLang, skinMode });
    setExportStatus("exporting");
    try {
      // 等 React commit + 離屏層渲染（兩個 frame 較可靠）
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      await exportJpeg(exportLayerRef.current);
      setExportStatus("idle");
      setExportSnapshot(null);
    } catch (err) {
      console.error("匯出失敗:", err);
      setExportStatus("error");
      setExportSnapshot(null);
      // 3 秒後自動清除錯誤提示
      if (exportErrorTimerRef.current) clearTimeout(exportErrorTimerRef.current);
      exportErrorTimerRef.current = setTimeout(() => {
        setExportStatus("idle");
      }, 3000);
    }
  };

  return (
    <main className="box-page">
      <div className="page-topbar">
        <LangSwitcher value={displayLang} onChange={setDisplayLang} />
        <div className="page-topbar__right">
          <button
            type="button"
            className="button-skin-toggle"
            data-active={skinMode === "insight"}
            aria-label="切換洞悉立繪"
            title="切換洞悉立繪"
            onClick={() =>
              setSkinMode(skinMode === "default" ? "insight" : "default")
            }
          >
            <Sparkles size={15} />
          </button>
          <button
            type="button"
            className="button-reset-all"
            aria-label={t.resetAll}
            title={t.resetAll}
            onClick={() => setShowResetConfirm(true)}
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </div>

      <AppHeader total={characters.length} states={states} lang={displayLang} />

      <ControlBar
        search={search}
        filterMode={filterMode}
        lang={displayLang}
        onSearchChange={setSearch}
        onFilterChange={setFilterMode}
        onExport={handleExport}
        exportStatus={exportStatus}
      />

      <CharacterGrid
        characters={visibleCharacters}
        states={states}
        lang={displayLang}
        skinMode={skinMode}
        onActivate={activateCharacter}
        onDecrease={decreasePortray}
        onRemove={removeCharacter}
      />

      <footer className="page-footer">
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          title="GitHub"
        >
          {REPO_URL}
        </a>
      </footer>

      <ConfirmDialog
        open={showResetConfirm}
        title={t.resetTitle}
        message={t.resetMessage}
        confirmLabel={t.resetConfirm}
        cancelLabel={t.resetCancel}
        onConfirm={() => resetAll()}
        onCancel={() => setShowResetConfirm(false)}
      />

      {/* 離屏匯出層（spec §24.2）；匯出中用快照凍結狀態 */}
      <div className="export-layer" ref={exportLayerRef} aria-hidden="true">
        <ExportCanvas
          characters={characters}
          states={exportSnapshot?.states ?? states}
          lang={exportSnapshot?.lang ?? displayLang}
          skinMode={exportSnapshot?.skinMode ?? skinMode}
        />
      </div>
    </main>
  );
}
