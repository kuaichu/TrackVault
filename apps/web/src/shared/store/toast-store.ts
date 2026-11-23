import { create } from "zustand";

export type ToastVariant = "success" | "error" | "info";

export interface ToastItem {
  id: string;
  variant: ToastVariant;
  message: string;
}

interface ToastState {
  items: ToastItem[];
  push(variant: ToastVariant, message: string): void;
  dismiss(id: string): void;
}

export const useToastStore = create<ToastState>((set) => ({
  items: [],
  push(variant, message) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((state) => ({
      items: [...state.items.slice(-3), { id, variant, message }],
    }));
    window.setTimeout(() => {
      set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
    }, 3600);
  },
  dismiss(id) {
    set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
  },
}));

export const toast = {
  success: (message: string) => useToastStore.getState().push("success", message),
  error: (message: string) => useToastStore.getState().push("error", message),
  info: (message: string) => useToastStore.getState().push("info", message),
};
