import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, RotateCcw } from "lucide-react";

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
import { getAllNames } from "./utils/i18n";
import { resolveModeVariant } from "./utils/skins";
import { STORAGE_ERROR_EVENT, consumeStorageError } from "./utils/storage";
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
  const userId = useBoxStore((s) => s.userId);
  const displayLang = useBoxStore((s) => s.displayLang);
  const setFilterMode = useBoxStore((s) => s.setFilterMode);
  const setSearch = useBoxStore((s) => s.setSearch);
  const setRarityFilter = useBoxStore((s) => s.setRarityFilter);
  const setUserId = useBoxStore((s) => s.setUserId);
  const setDisplayLang = useBoxStore((s) => s.setDisplayLang);
  const setActiveVariant = useBoxStore((s) => s.setActiveVariant);
  const activateCharacter = useBoxStore((s) => s.activateCharacter);
  const decreasePortray = useBoxStore((s) => s.decreasePortray);
  const resetAll = useBoxStore((s) => s.resetAll);
  const showFutureSight = useBoxStore((s) => s.showFutureSight);
  const setShowFutureSight = useBoxStore((s) => s.setShowFutureSight);
  const purgeUnreleased = useBoxStore((s) => s.purgeUnreleased);
  const defaultSkinMode = useBoxStore((s) => s.defaultSkinMode);
  const setSkinMode = useBoxStore((s) => s.setSkinMode);

  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showFutureSightConfirm, setShowFutureSightConfirm] = useState(false);
  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const [exportProgress, setExportProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [exportSnapshot, setExportSnapshot] = useState<{
    states: typeof states;
    lang: typeof displayLang;
    activeVariant: typeof activeVariant;
    userId: string;
    characters: typeof visibleCharacters;
  } | null>(null);
  const isExportingRef = useRef(false);
  const exportLayerElRef = useRef<HTMLDivElement | null>(null);
  const exportAttemptRef = useRef(0);
  const [storageError, setStorageError] = useState(false);
  const t = getUiText(displayLang);

  // localStorage 寫入失敗警告（含 mount 前早期失敗的補救）
  useEffect(() => {
    if (consumeStorageError()) setStorageError(true);
    const onStorageError = () => setStorageError(true);
    window.addEventListener(STORAGE_ERROR_EVENT, onStorageError);
    return () => window.removeEventListener(STORAGE_ERROR_EVENT, onStorageError);
  }, []);

  // 初始化 activeVariant：hydrate 後依 defaultSkinMode 補上缺漏的角色
  const initDone = useRef(false);
  useEffect(() => {
    const unsub = useBoxStore.persist.onFinishHydration(() => {
      if (initDone.current) return;
      initDone.current = true;
      const store = useBoxStore.getState();

      // Auto-detect language from browser locale on first-ever visit
      // (only when the user hasn't manually chosen a language before)
      if (!store.langChosen) {
        const locale = navigator.language;
        const langMap: Record<string, LangCode> = {
          "zh-CN": "zh-CN", "zh-SG": "zh-CN", "zh": "zh-CN",
          "zh-TW": "zh-TW", "zh-HK": "zh-TW",
          "ja": "ja-JP", "ko": "ko-KR",
        };
        const autoLang = langMap[locale] ?? langMap[locale.split("-")[0]] ?? "en-US";
        useBoxStore.setState({ displayLang: autoLang, langChosen: true });
      }

      let changed = false;
      const next = { ...store.activeVariant };
      for (const c of characters) {
        if (!next[c.id]) {
          next[c.id] = resolveModeVariant(c, store.defaultSkinMode);
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

  const visibleCharacters = useMemo(() => {
    const query = search.trim().toLowerCase();
    return characters.filter((c) => {
      if (!showFutureSight && !c.isReleased) return false;
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
  }, [states, filterMode, search, rarityFilter, showFutureSight]);

  const handleExport = () => {
    if (isExportingRef.current) return;
    isExportingRef.current = true;
    exportAttemptRef.current += 1;
    setExportSnapshot({
      states: { ...states },
      lang: displayLang,
      activeVariant: { ...activeVariant },
      userId,
      characters: visibleCharacters,
    });
    setExportStatus("exporting");
    setExportProgress(null);
  };

  // 匯出 lifecycle：mount ExportCanvas → 等 render → 截圖 → unmount
  useEffect(() => {
    if (!exportSnapshot) return;

    let cancelled = false;
    const attemptId = exportAttemptRef.current;
    let errorTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      cancelled = true;
      isExportingRef.current = false;
      if (errorTimer) clearTimeout(errorTimer);
    };

    const run = async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      if (cancelled) return;

      let exportJpeg: typeof import("./utils/export-image").exportJpeg;
      try {
        const mod = await import("./utils/export-image");
        exportJpeg = mod.exportJpeg;
      } catch {
        if (!cancelled) {
          setExportStatus("error");
          isExportingRef.current = false;
          errorTimer = setTimeout(() => {
            if (exportAttemptRef.current !== attemptId) return;
            setExportStatus("idle");
            setExportSnapshot(null);
            setExportProgress(null);
          }, 3000);
        }
        return;
      }
      if (cancelled) return;

      const el = exportLayerElRef.current;
      if (!el) {
        isExportingRef.current = false;
        setExportSnapshot(null);
        setExportStatus("idle");
        setExportProgress(null);
        return;
      }

      try {
        await exportJpeg(el, (p) => {
          if (!cancelled) setExportProgress(p);
        });
        if (!cancelled) {
          setExportStatus("idle");
          setExportSnapshot(null);
          setExportProgress(null);
          isExportingRef.current = false;
        }
      } catch (err) {
        console.error("匯出失敗:", err);
        if (!cancelled) {
          setExportStatus("error");
          isExportingRef.current = false;
          errorTimer = setTimeout(() => {
            if (exportAttemptRef.current !== attemptId) return;
            setExportStatus("idle");
            setExportSnapshot(null);
            setExportProgress(null);
          }, 3000);
        }
      }
    };

    void run();

    return cleanup;
  }, [exportSnapshot]);

  const handleSkinSelect = (charId: string, variantId: string) => {
    setActiveVariant(charId, variantId);
  };

  return (
    <main className="box-page">
      <div className="page-topbar">
        <LangSwitcher value={displayLang} onChange={setDisplayLang} />
        <button
          type="button"
          className="button-future-sight"
          aria-label={t.futureSightLabel}
          title={showFutureSight ? t.futureSightOn : t.futureSightOff}
          onClick={() => {
            if (showFutureSight) {
              setShowFutureSight(false);
              purgeUnreleased(
                characters.filter((c) => !c.isReleased).map((c) => c.id)
              );
            } else {
              setShowFutureSightConfirm(true);
            }
          }}
        >
          {showFutureSight ? <Eye size={15} /> : <EyeOff size={15} />}
          <span>{t.futureSightLabel}</span>
        </button>
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

      {storageError && (
        <div className="page-storage-warning" role="alert">
          {t.storageError}
        </div>
      )}

      <AppHeader characters={visibleCharacters} states={states} lang={displayLang} />

      <ControlBar
        search={search}
        filterMode={filterMode}
        rarityFilter={rarityFilter}
        lang={displayLang}
        skinMode={defaultSkinMode}
        onSkinModeChange={setSkinMode}
        onSearchChange={setSearch}
        onFilterChange={setFilterMode}
        onRarityFilterChange={setRarityFilter}
        userId={userId}
        onUserIdChange={setUserId}
        onExport={handleExport}
        exportStatus={exportStatus}
        exportProgress={exportProgress}
      />

      <CharacterGrid
        characters={visibleCharacters}
        states={states}
        lang={displayLang}
        activeVariant={activeVariant}
        showFutureSight={showFutureSight}
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
        onClose={() => setShowResetConfirm(false)}
      />

      <ConfirmDialog
        open={showFutureSightConfirm}
        title={t.spoilerLabel}
        message={t.futureSightWarning}
        confirmLabel={t.futureSightConfirm}
        cancelLabel={t.futureSightCancel}
        onConfirm={() => {
          setShowFutureSight(true);
          setShowFutureSightConfirm(false);
        }}
        onClose={() => setShowFutureSightConfirm(false)}
      />

      {/* 離屏匯出層（僅在匯出時 mount） */}
      {exportSnapshot && (
        <div
          className="export-layer"
          ref={exportLayerElRef}
          aria-hidden="true"
        >
          <ExportCanvas
            characters={exportSnapshot.characters}
            states={exportSnapshot.states}
            activeVariant={exportSnapshot.activeVariant}
            lang={exportSnapshot.lang}
            userId={exportSnapshot.userId}
          />
        </div>
      )}
    </main>
  );
}
