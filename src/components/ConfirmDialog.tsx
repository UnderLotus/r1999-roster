import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  /** 關閉 dialog（取消按鈕、backdrop、Escape、確認後皆會呼叫） */
  onClose: () => void;
}

/** 原生 <dialog> 確認視窗（spec §23） */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // 點擊 backdrop 關閉（dialog 內部點擊不會觸發）
        if (event.target === dialogRef.current) {
          onClose();
        }
      }}
    >
      <strong className="confirm-dialog__title">{title}</strong>
      <p className="confirm-dialog__message">{message}</p>
      <div className="confirm-dialog__actions">
        <button
          type="button"
          className="button button--quiet"
          onClick={onClose}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className="button button--primary"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
