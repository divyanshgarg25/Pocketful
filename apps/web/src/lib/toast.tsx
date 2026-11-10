import React, { useEffect, useState } from 'react';

export interface Toast {
  id: string;
  type: 'error' | 'success' | 'info';
  message: string;
}

type ToastListener = (toasts: Toast[]) => void;
let toasts: Toast[] = [];
const listeners = new Set<ToastListener>();

export const toast = {
  error(message: string) {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    toasts = [...toasts, { id, type: 'error', message }];
    listeners.forEach((l) => l(toasts));
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
      listeners.forEach((l) => l(toasts));
    }, 6000);
  },
  success(message: string) {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    toasts = [...toasts, { id, type: 'success', message }];
    listeners.forEach((l) => l(toasts));
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
      listeners.forEach((l) => l(toasts));
    }, 4000);
  },
  dismiss(id: string) {
    toasts = toasts.filter((t) => t.id !== id);
    listeners.forEach((l) => l(toasts));
  },
  subscribe(listener: ToastListener) {
    listeners.add(listener);
    listener(toasts);
    return () => {
      listeners.delete(listener);
    };
  }
};

export const ToastContainer: React.FC = () => {
  const [currentToasts, setCurrentToasts] = useState<Toast[]>([]);

  useEffect(() => {
    return toast.subscribe((updated) => setCurrentToasts([...updated]));
  }, []);

  if (currentToasts.length === 0) return null;

  return (
    <div
      aria-live="assertive"
      className="fixed bottom-5 right-5 z-[100] flex flex-col gap-2 max-w-sm w-full pointer-events-none"
    >
      {currentToasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          className={`pointer-events-auto flex items-start justify-between gap-3 p-3.5 rounded-[3px] border shadow-lift font-ui text-xs animate-in slide-in-from-bottom-2 ${
            t.type === 'error'
              ? 'bg-linen border-burgundy/40 text-burgundy'
              : 'bg-parchment border-brass text-ink'
          }`}
        >
          <div className="flex items-start gap-2">
            <span className="font-bold text-sm leading-none">
              {t.type === 'error' ? '!' : '✓'}
            </span>
            <span className="leading-relaxed">{t.message}</span>
          </div>
          <button
            type="button"
            onClick={() => toast.dismiss(t.id)}
            className="text-taupe hover:text-ink font-mono font-bold leading-none p-0.5"
            aria-label="Dismiss alert"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
};
