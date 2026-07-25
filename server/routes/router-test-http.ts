import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { RequestHandler } from "express";
import { runWithRequestContext } from "../request-context.js";

export type TestHttpResponse = {
  status: number;
  body: unknown;
};

export type TestHttpClient = {
  request: (path: string, init?: RequestInit) => Promise<TestHttpResponse>;
  requestJson: (method: "POST" | "PUT", path: string, body: unknown, headers?: HeadersInit) => Promise<TestHttpResponse>;
};

async function closeServer(server: Server) {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function withTestRouter(
  handlers: RequestHandler[],
  callback: (client: TestHttpClient) => Promise<void>
) {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const headerSessionId = request.get("x-client-session-id");
    const querySessionId = typeof request.query.sid === "string" ? request.query.sid : undefined;
    runWithRequestContext(headerSessionId || querySessionId, next);
  });
  for (const handler of handlers) {
    app.use(handler);
  }
  app.use((_request, response) => {
    response.status(404).json({ message: "test fallback" });
  });

  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test HTTP server did not expose a TCP address.");
    }

    const { port } = address satisfies AddressInfo;
    const request = async (path: string, init?: RequestInit): Promise<TestHttpResponse> => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
      return {
        status: response.status,
        body: await response.json()
      };
    };
    const requestJson = (method: "POST" | "PUT", path: string, body: unknown, headers?: HeadersInit) =>
      request(path, {
        method,
        headers: {
          "content-type": "application/json",
          ...Object.fromEntries(new Headers(headers))
        },
        body: JSON.stringify(body)
      });

    await callback({ request, requestJson });
  } finally {
    await closeServer(server);
  }
}
