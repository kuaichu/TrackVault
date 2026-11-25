export interface SseSubscriptionOptions {
  url: string;
  withCredentials?: boolean;
  onMessage: (rawData: string) => void;
  onReconnect?: () => void;
  onOnline?: () => void;
}

/**
 * Pure generic EventSource subscription with reconnect and browser `online` detection.
 * Contains zero domain logic, cache reconciliation, or UI notifications.
 */
export function subscribeSse(options: SseSubscriptionOptions): () => void {
  const handleOnline = () => {
    options.onOnline?.();
  };

  if (typeof window !== "undefined") {
    window.addEventListener("online", handleOnline);
  }

  if (typeof EventSource === "undefined") {
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("online", handleOnline);
      }
    };
  }

  let hasOpenedOnce = false;
  let hadError = false;

  const es = new EventSource(options.url, {
    withCredentials: options.withCredentials ?? true,
  });

  es.onopen = () => {
    if (hasOpenedOnce || hadError) {
      hadError = false;
      options.onReconnect?.();
    }
    hasOpenedOnce = true;
  };

  es.onerror = () => {
    hadError = true;
  };

  es.onmessage = (event) => {
    options.onMessage(String(event.data ?? ""));
  };

  return () => {
    es.close();
    if (typeof window !== "undefined") {
      window.removeEventListener("online", handleOnline);
    }
  };
}
