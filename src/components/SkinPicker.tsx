import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Shirt } from "lucide-react";

import type { Character } from "../types/character";
import { prefixedAvatarPath } from "../utils/assets";

interface SkinPickerProps {
  character: Character;
  activeVariant: string;
  onSelect: (variantId: string) => void;
  onClose: () => void;
}

export function SkinPicker({
  character,
  activeVariant,
  onSelect,
  onClose,
}: SkinPickerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);

  // Adjust horizontal position to stay within viewport
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const overhangRight = rect.right - window.innerWidth + 8;
    const overhangLeft = 8 - rect.left;
    if (overhangRight > 0) setShift(-overhangRight);
    else if (overhangLeft > 0) setShift(overhangLeft);
    else setShift(0);
  }, [character.id]);

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

  // Preload non-active variant images
  useEffect(() => {
    for (const skin of character.skins) {
      if (skin.variantId !== activeVariant) {
        const img = new Image();
        img.src = prefixedAvatarPath(skin.variantId);
      }
    }
  }, [character.skins, activeVariant]);

  return (
    <div
      className="skin-picker"
      ref={panelRef}
      style={{ "--picker-shift": `${shift}px` } as React.CSSProperties}
    >
      <div className="skin-picker__grid">
        {character.skins.map((skin) => (
          <button
            key={skin.variantId}
            type="button"
            className="skin-picker__thumb"
            data-active={skin.variantId === activeVariant}
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
}: {
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="character-action character-action--skin"
      aria-label="更換立繪"
      title="更換立繪"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <Shirt size={14} strokeWidth={2} />
    </button>
  );
}
