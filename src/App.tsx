import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";

import { AppHeader } from "./components/AppHeader";
import { CharacterGrid } from "./components/CharacterGrid";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ControlBar } from "./components/ControlBar";
import { ExportCanvas } from "./components/ExportCanvas";
import { LangSwitcher } from "./components/LangSwitcher";
import { characters } from "./data/characters";
import { getUiText } from "./i18n/ui";
import { useBoxStore } from "./store/boxStore";
import type { LangCode } from "./store/boxStore";
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
  const activeVariant = useBoxStore((s) => s.activeVariant);
  const filterMode = useBoxStore((s) => s.filterMode);
  const search = useBoxStore((s) => s.search);
  const rarityFilter = useBoxStore((s) => s.rarityFilter);
  const displayLang = useBoxStore((s) => s.displayLang);
  const setFilterMode = useBoxStore((s) => s.setFilterMode);
  const setSearch = useBoxStore((s) => s.setSearch);
  const setRarityFilter = useBoxStore((s) => s.setRarityFilter);
  const setDisplayLang = useBoxStore((s) => s.setDisplayLang);
  const setActiveVariant = useBoxStore((s) => s.setActiveVariant);
  const activateCharacter = useBoxStore((s) => s.activateCharacter);
  const decreasePortray = useBoxStore((s) => s.decreasePortray);
  const resetAll = useBoxStore((s) => s.resetAll);

  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const exportErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [exportSnapshot, setExportSnapshot] = useState<{
    states: typeof states;
    lang: typeof displayLang;
    activeVariant: typeof activeVariant;
  } | null>(null);
  const exportLayerRef = useRef<HTMLDivElement>(null);
  const t = getUiText(displayLang);

  // 初始化 activeVariant：hydrate 後補上漏掉的 defaultVariant
  const initDone = useRef(false);
  useEffect(() => {
    const unsub = useBoxStore.persist.onFinishHydration(() => {
      if (initDone.current) return;
      initDone.current = true;
      const store = useBoxStore.getState();

      // Auto-detect language from browser locale on first-ever visit
      // (only when displayLang is still the default — user hasn't manually chosen one)
      if (store.displayLang === "en-US") {
        const locale = navigator.language;
        const langMap: Record<string, LangCode> = {
          "zh-CN": "zh-CN", "zh-SG": "zh-CN", "zh": "zh-CN",
          "zh-TW": "zh-TW", "zh-HK": "zh-TW",
          "ja": "ja-JP", "ko": "ko-KR",
        };
        const autoLang = langMap[locale] ?? langMap[locale.split("-")[0]] ?? "en-US";
        store.displayLang = autoLang;
        useBoxStore.setState({ displayLang: autoLang });
      }

      let changed = false;
      const next = { ...store.activeVariant };
      for (const c of characters) {
        if (!next[c.id]) {
          next[c.id] = c.defaultVariant;
          changed = true;
        }
      }
      if (changed) {
        useBoxStore.setState({ activeVariant: next });
      }
    });
    return unsub;
  }, []);

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
      if (
        query &&
        !getAllNames(c).some((name) => name.toLowerCase().includes(query))
      ) {
        return false;
      }
      if (
        rarityFilter.length > 0 &&
        c.rarity !== undefined &&
        !rarityFilter.includes(c.rarity)
      ) {
        return false;
      }
      return true;
    });
  }, [states, filterMode, search, rarityFilter]);

  const handleExport = async () => {
    if (exportStatus === "exporting" || !exportLayerRef.current) return;
    if (exportErrorTimerRef.current) {
      clearTimeout(exportErrorTimerRef.current);
      exportErrorTimerRef.current = null;
    }
    setExportSnapshot({
      states: { ...states },
      lang: displayLang,
      activeVariant: { ...activeVariant },
    });
    setExportStatus("exporting");
    try {
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
      if (exportErrorTimerRef.current) clearTimeout(exportErrorTimerRef.current);
      exportErrorTimerRef.current = setTimeout(() => {
        setExportStatus("idle");
      }, 3000);
    }
  };

  const handleSkinSelect = (charId: string, variantId: string) => {
    setActiveVariant(charId, variantId);
  };

  return (
    <main className="box-page">
      <div className="page-topbar">
        <LangSwitcher value={displayLang} onChange={setDisplayLang} />
        <div className="page-topbar__right">
          <a
            href="https://ko-fi.com/H2Y624M8O8"
            target="_blank"
            rel="noopener noreferrer"
            className="button-kofi"
          >
            <img
              src="https://storage.ko-fi.com/cdn/kofi1.png?v=6"
              alt="Support me on Ko-fi"
              height="30"
            />
          </a>
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
        rarityFilter={rarityFilter}
        lang={displayLang}
        onSearchChange={setSearch}
        onFilterChange={setFilterMode}
        onRarityFilterChange={setRarityFilter}
        onExport={handleExport}
        exportStatus={exportStatus}
      />

      <CharacterGrid
        characters={visibleCharacters}
        states={states}
        lang={displayLang}
        activeVariant={activeVariant}
        onActivate={activateCharacter}
        onDecrease={decreasePortray}
        onSkinSelect={handleSkinSelect}
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

      {/* 離屏匯出層 */}
      <div className="export-layer" ref={exportLayerRef} aria-hidden="true">
        <ExportCanvas
          characters={characters}
          states={exportSnapshot?.states ?? states}
          activeVariant={exportSnapshot?.activeVariant ?? activeVariant}
          lang={exportSnapshot?.lang ?? displayLang}
        />
      </div>
    </main>
  );
}
