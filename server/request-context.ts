import { AsyncLocalStorage } from "node:async_hooks";

type RequestContext = {
  clientSessionId: string;
};

const requestContextStore = new AsyncLocalStorage<RequestContext>();

function sanitizeSessionId(value: string | undefined | null) {
  const normalized = (value ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return normalized || "default";
}

export function runWithRequestContext<T>(clientSessionId: string | undefined | null, callback: () => T) {
  return requestContextStore.run(
    {
      clientSessionId: sanitizeSessionId(clientSessionId)
    },
    callback
  );
}

export function getClientSessionId() {
  return requestContextStore.getStore()?.clientSessionId ?? "default";
}
