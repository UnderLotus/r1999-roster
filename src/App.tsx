import { useEffect, useMemo, useRef, useState } from "react";
import { Github, Eye, EyeOff, RotateCcw } from "lucide-react";

import { AppHeader } from "./components/AppHeader";
import { CharacterGrid } from "./components/CharacterGrid";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ControlBar } from "./components/ControlBar";
import { ExportCanvas } from "./components/ExportCanvas";
import { LangSwitcher } from "./components/LangSwitcher";
import { ShareUrlDialog } from "./components/ShareUrlDialog";
import { characters } from "./data/characters";
import { getUiText } from "./i18n/ui";
import { useExportJob } from "./hooks/useExportJob";
import { useBoxStore } from "./store/boxStore";
import type { LangCode } from "./store/boxStore";
import { getAllNames } from "./utils/i18n";
import { decodeShareCode, encodeShareCode } from "./utils/share-code";
import type { SharePayload } from "./utils/share-code";
import { STORAGE_ERROR_EVENT, consumeStorageError } from "./utils/storage";
import "./styles/character-card.css";
import "./styles/app-header.css";
import "./styles/control-bar.css";
import "./styles/export-canvas.css";

/** 主站網址（頁尾顯示與連結） */
const SITE_URL = "https://underlotus.github.io";

/** 同時支援同步與未來可能的非同步 persist hydration。 */
function onStoreHydrated(callback: () => void): () => void {
  if (useBoxStore.persist.hasHydrated()) {
    callback();
    return () => {};
  }
  return useBoxStore.persist.onFinishHydration(callback);
}

function clearShareHash(): void {
  window.history.replaceState(
    null,
    "",
    window.location.pathname + window.location.search
  );
}

export default function App() {
  const states = useBoxStore((s) => s.characters);
  const activeVariant = useBoxStore((s) => s.activeVariant);
  const customVariants = useBoxStore((s) => s.customVariants);
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
  const importBox = useBoxStore((s) => s.importBox);
  const defaultSkinMode = useBoxStore((s) => s.defaultSkinMode);
  const setSkinMode = useBoxStore((s) => s.setSkinMode);

  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showFutureSightConfirm, setShowFutureSightConfirm] = useState(false);
  const [pendingImport, setPendingImport] = useState<SharePayload | null>(null);
  const [shareStatus, setShareStatus] = useState<"idle" | "copied">("idle");
  const [shareDialogUrl, setShareDialogUrl] = useState<string | null>(null);
  const shareTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [storageError, setStorageError] = useState(false);
  const t = getUiText(displayLang);

  // localStorage 寫入失敗警告（含 mount 前早期失敗的補救）
  useEffect(() => {
    if (consumeStorageError()) setStorageError(true);
    const onStorageError = () => setStorageError(true);
    window.addEventListener(STORAGE_ERROR_EVENT, onStorageError);
    return () => window.removeEventListener(STORAGE_ERROR_EVENT, onStorageError);
  }, []);

  // Hydration 後只處理首次造訪的語言偏好；Box reconciliation 由 store 負責。
  const initDone = useRef(false);
  useEffect(() => {
    return onStoreHydrated(() => {
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
    });
  }, []);

  // URL 分享匯入（#b=<token>）：初次載入與同頁 hash 變更都處理。
  useEffect(() => {
    let hydrated = false;
    const handleShareHash = () => {
      if (!hydrated || !window.location.hash.startsWith("#b=")) return;
      const payload = decodeShareCode(window.location.hash.slice(3));
      if (!payload) {
        clearShareHash(); // 壞 token：靜默清除，不騷擾使用者
        return;
      }
      setPendingImport(payload);
    };

    const unsubscribeHydration = onStoreHydrated(() => {
      hydrated = true;
      handleShareHash();
    });
    window.addEventListener("hashchange", handleShareHash);

    return () => {
      unsubscribeHydration();
      window.removeEventListener("hashchange", handleShareHash);
    };
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

  const {
    status: exportStatus,
    progress: exportProgress,
    snapshot: exportSnapshot,
    start: startExport,
    targetRef: exportLayerElRef,
  } = useExportJob<{
    states: typeof states;
    lang: typeof displayLang;
    activeVariant: typeof activeVariant;
    skinMode: typeof defaultSkinMode;
    userId: string;
    characters: typeof visibleCharacters;
  }>();

  const handleExport = () => {
    startExport({
      states: { ...states },
      lang: displayLang,
      activeVariant: { ...activeVariant },
      skinMode: defaultSkinMode,
      userId,
      characters: visibleCharacters,
    });
  };

  const handleSkinSelect = (charId: string, variantId: string) => {
    setActiveVariant(charId, variantId);
  };

  const handleShareUrl = async () => {
    const token = encodeShareCode({
      characters: states,
      activeVariant,
      customVariants,
      defaultSkinMode,
      showFutureSight,
    });
    const url = `${window.location.origin}${window.location.pathname}#b=${token}`;
    try {
      await navigator.clipboard.writeText(url);
      setShareStatus("copied");
      if (shareTimerRef.current) clearTimeout(shareTimerRef.current);
      shareTimerRef.current = setTimeout(() => setShareStatus("idle"), 1600);
    } catch {
      setShareDialogUrl(url); // clipboard 不可用：fallback dialog
    }
  };

  const applyImport = (payload: SharePayload) => {
    importBox(payload);
    setPendingImport(null);
    clearShareHash();
  };

  const cancelImport = () => {
    setPendingImport(null);
    clearShareHash();
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
        ownedCount={Object.keys(states).length}
        shareStatus={shareStatus}
        onExport={handleExport}
        onShareUrl={handleShareUrl}
        exportStatus={exportStatus}
        exportProgress={exportProgress}
      />

      <CharacterGrid
        characters={visibleCharacters}
        states={states}
        lang={displayLang}
        activeVariant={activeVariant}
        skinMode={defaultSkinMode}
        showFutureSight={showFutureSight}
        onActivate={activateCharacter}
        onDecrease={decreasePortray}
        onSkinSelect={handleSkinSelect}
      />

      <footer className="page-footer">
        <a
          className="repo-banner"
          href={SITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          title="UnderLotus 主站"
        >
          <Github size={22} strokeWidth={1.5} aria-hidden="true" />
          <span className="repo-banner__text">
            <span className="repo-banner__name">underlotus</span>
            <span className="repo-banner__url">
              {SITE_URL.replace("https://", "")}
            </span>
          </span>
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

      <ConfirmDialog
        open={pendingImport !== null}
        title={t.importBoxTitle}
        message={
          pendingImport?.showFutureSight ? (
            <>
              {t.importBoxFuturePrefix(
                Object.keys(pendingImport.characters).length
              )}
              <strong>{t.futureSightLabel}</strong>
              {t.importBoxFutureSuffix}
            </>
          ) : (
            t.importBoxMessage(
              Object.keys(pendingImport?.characters ?? {}).length
            )
          )
        }
        confirmLabel={t.importBoxConfirm}
        cancelLabel={t.importBoxCancel}
        onConfirm={() => pendingImport && applyImport(pendingImport)}
        onClose={cancelImport}
      />

      <ShareUrlDialog
        open={shareDialogUrl !== null}
        url={shareDialogUrl ?? ""}
        lang={displayLang}
        onClose={() => setShareDialogUrl(null)}
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
            skinMode={exportSnapshot.skinMode}
            lang={exportSnapshot.lang}
            userId={exportSnapshot.userId}
          />
        </div>
      )}
    </main>
  );
}
