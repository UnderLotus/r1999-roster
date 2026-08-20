import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Shirt } from "lucide-react";

import type { Character } from "../types/character";
import { getUiText } from "../i18n/ui";
import { getDisplayName } from "../utils/i18n";
import { prefixedAvatarPath } from "../utils/assets";
import type { LangCode } from "../store/boxStore";

interface SkinPickerProps {
  character: Character;
  activeVariant: string;
  showFutureSight: boolean;
  lang: LangCode;
  onSelect: (variantId: string) => void;
  onClose: () => void;
}

export function SkinPicker({
  character,
  activeVariant,
  showFutureSight,
  lang,
  onSelect,
  onClose,
}: SkinPickerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  const [flip, setFlip] = useState(false);
  const t = getUiText(lang);
  const charName = getDisplayName(character, lang);

  // Adjust position to stay within viewport (horizontal shift + vertical flip)
  const reposition = useCallback(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const overhangRight = rect.right - window.innerWidth + 8;
    const overhangLeft = 8 - rect.left;
    if (overhangRight > 0) setShift(-overhangRight);
    else if (overhangLeft > 0) setShift(overhangLeft);
    else setShift(0);

    // 垂直：上方不足則往下開；若下方也不足，選溢出較少的一側
    const overhangTop = 8 - rect.top;
    const overhangBottom = rect.bottom - window.innerHeight + 8;
    if (overhangTop > 0 && overhangBottom > 0) {
      setFlip(overhangTop < overhangBottom); // 上方溢出較少 → 往下開
    } else if (overhangTop > 0) {
      setFlip(true);
    } else if (overhangBottom > 0) {
      setFlip(false);
    } else {
      setFlip(false); // 上下皆無溢出：維持向上開
    }
  }, []);

  useLayoutEffect(() => {
    reposition();
  }, [reposition, character.id]);

  // 視窗縮放／捲動時重算定位
  useLayoutEffect(() => {
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [reposition]);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  return (
    <div
      className={`skin-picker${flip ? " skin-picker--flip" : ""}`}
      ref={panelRef}
      style={{ "--picker-shift": `${shift}px` } as React.CSSProperties}
    >
      <div className="skin-picker__grid">
        {character.skins
          .filter(
            (skin) =>
              showFutureSight || skin.isReleased !== false // 未實裝 skin 只在未來視模式顯示
          )
          .map((skin) => (
            <button
              key={skin.variantId}
              type="button"
              className="skin-picker__thumb"
              data-active={skin.variantId === activeVariant}
              aria-label={t.skinPickerItem(
                charName,
                skin.skinName ?? (skin.type === "insight" ? t.skinModeInsight : t.skinModeInitial)
              )}
              onClick={() => {
                onSelect(skin.variantId);
                onClose();
              }}
            >
              <img
                src={prefixedAvatarPath(skin.variantId)}
                alt=""
                className="skin-picker__thumb-img"
              />
            </button>
          ))}
      </div>
    </div>
  );
}

/** The trigger button that opens the skin picker */
export function SkinPickerTrigger({
  onClick,
  lang,
}: {
  onClick: () => void;
  lang: LangCode;
}) {
  const t = getUiText(lang);
  return (
    <button
      type="button"
      className="character-action character-action--skin"
      aria-label={t.skinPickerTrigger}
      title={t.skinPickerTrigger}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <Shirt size={14} strokeWidth={2} />
    </button>
  );
}
