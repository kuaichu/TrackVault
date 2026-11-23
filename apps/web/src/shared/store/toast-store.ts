import { create } from "zustand";
import { sanitizeExternalUrl } from "#shared";

export type ToastVariant = "success" | "error" | "info";

export interface ToastAction {
  label: string;
  href: string;
}

export interface ToastOptions {
  action?: ToastAction;
  durationMs?: number;
}

export interface ToastItem {
  id: string;
  variant: ToastVariant;
  message: string;
  action?: ToastAction;
}

const MAX_TOASTS = 3;
const DEFAULT_TOAST_DURATION_MS = 3600;
const ACTION_TOAST_DURATION_MS = 8000;

interface ToastState {
  items: ToastItem[];
  push(variant: ToastVariant, message: string, options?: ToastOptions): void;
  dismiss(id: string): void;
  clear(): void;
}

export const useToastStore = create<ToastState>((set) => ({
  items: [],
  push(variant, message, options) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const safeHref = options?.action ? sanitizeExternalUrl(options.action.href) : null;
    const safeAction =
      options?.action && safeHref ? { label: options.action.label, href: safeHref } : undefined;
    const nextItem: ToastItem = safeAction
      ? { id, variant, message, action: safeAction }
      : { id, variant, message };

    set((state) => ({
      items: [...state.items.slice(-(MAX_TOASTS - 1)), nextItem],
    }));

    const durationMs =
      options?.durationMs ?? (safeAction ? ACTION_TOAST_DURATION_MS : DEFAULT_TOAST_DURATION_MS);
    window.setTimeout(() => {
      set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
    }, durationMs);
  },
  dismiss(id) {
    set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
  },
  clear() {
    set({ items: [] });
  },
}));

export const toast = {
  success: (message: string, options?: ToastOptions) =>
    useToastStore.getState().push("success", message, options),
  error: (message: string, options?: ToastOptions) =>
    useToastStore.getState().push("error", message, options),
  info: (message: string, options?: ToastOptions) => useToastStore.getState().push("info", message, options),
};
