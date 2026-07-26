import { AsyncLocalStorage } from "node:async_hooks";

type RequestContext = {
  clientSessionId: string | null;
};

const requestContextStore = new AsyncLocalStorage<RequestContext>();

export class InvalidClientSessionIdError extends Error {
  constructor() {
    super("缺少或无效的客户端会话标识。");
    this.name = "InvalidClientSessionIdError";
  }
}

export function parseClientSessionId(value: string | undefined | null) {
  const normalized = (value ?? "").trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(normalized) || normalized.toLowerCase() === "default") {
    return null;
  }
  return normalized;
}

export function runWithRequestContext<T>(clientSessionId: string | undefined | null, callback: () => T) {
  return requestContextStore.run(
    {
      clientSessionId: parseClientSessionId(clientSessionId)
    },
    callback
  );
}

export function getClientSessionId() {
  return requestContextStore.getStore()?.clientSessionId ?? "default";
}

export function getRequiredClientSessionId() {
  const clientSessionId = requestContextStore.getStore()?.clientSessionId;
  if (!clientSessionId) {
    throw new InvalidClientSessionIdError();
  }
  return clientSessionId;
}
