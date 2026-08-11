import { useEffect, useRef, useState } from "react";

import type { LangCode } from "../store/boxStore";
import { getUiText } from "../i18n/ui";

interface ShareUrlDialogProps {
  open: boolean;
  url: string;
  lang: LangCode;
  onClose: () => void;
}

/** clipboard 失敗時的分享網址 fallback dialog（spec §25） */
export function ShareUrlDialog({ open, url, lang, onClose }: ShareUrlDialogProps) {
  const t = getUiText(lang);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
      requestAnimationFrame(() => inputRef.current?.select());
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // 舊瀏覽器 fallback：選取 + execCommand
      const input = inputRef.current;
      if (input) {
        input.select();
        try {
          if (!document.execCommand("copy")) return;
        } catch {
          return;
        }
      }
    }
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1600);
  };

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) {
          onClose();
        }
      }}
    >
      <strong className="confirm-dialog__title">{t.shareDialogTitle}</strong>
      <p className="confirm-dialog__message">{t.shareDialogHint}</p>
      <input
        ref={inputRef}
        className="share-url-input"
        type="text"
        readOnly
        value={url}
        aria-label={t.shareDialogTitle}
        onFocus={(event) => event.target.select()}
      />
      <div className="confirm-dialog__actions">
        <button type="button" className="button button--quiet" onClick={onClose}>
          {t.importBoxCancel}
        </button>
        <button type="button" className="button button--url" onClick={handleCopy}>
          {copied ? t.shareCopied : t.copyLabel}
        </button>
      </div>
    </dialog>
  );
}
