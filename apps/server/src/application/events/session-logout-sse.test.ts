import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildServer } from "../../app.js";
import { loadServerConfig } from "../../config/env.js";
import { ProviderRegistry } from "../../domain/ports/music-provider.js";
import { SessionEventHub } from "./session-event-hub.js";

function extractCookieHeader(setCookies: string | string[] | undefined): string {
  const list = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : [];
  return list.map((c) => c.split(";")[0]).join("; ");
}

test("SessionEventHub closes only the logged-out session SSE connections while keeping other user sessions alive", () => {
  const hub = new SessionEventHub();
  const closed: string[] = [];

  const unreg1 = hub.register({
    userId: "u1",
    sessionTokenHash: "hash-s1",
    close: () => {
      closed.push("s1");
      unreg1();
    },
  });
  const unreg2 = hub.register({
    userId: "u1",
    sessionTokenHash: "hash-s2",
    close: () => {
      closed.push("s2");
      unreg2();
    },
  });

  hub.closeSessionConnections("hash-s1");
  assert.deepEqual(closed, ["s1"]);

  hub.closeUserConnections("u1");
  assert.deepEqual(closed, ["s1", "s2"]);
});

test("POST /api/auth/logout immediately closes the logged-out session SSE stream while leaving another session stream open", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-sse-logout-"));
  const config = loadServerConfig({
    NODE_ENV: "test",
    DATA_DIR: tmpDir,
    ALLOWED_ORIGINS: "http://127.0.0.1:5174",
    COOKIE_SECURE: "false",
  });

  const server = await buildServer({
    config,
    dbPathOverride: ":memory:",
    providersOverride: new ProviderRegistry(),
    disableRateLimit: true,
    serveStaticWeb: false,
  });

  const openSse = (baseUrl: string, cookie: string) =>
    new Promise<{
      req: http.ClientRequest;
      res: http.IncomingMessage;
      closedPromise: Promise<void>;
    }>((resolve, reject) => {
      const req = http.get(`${baseUrl}/api/events`, { headers: { Cookie: cookie } }, (res) => {
        const closedPromise = new Promise<void>((resClosed) => {
          res.once("end", resClosed);
          res.once("close", resClosed);
        });
        // Consume stream so end/close fires cleanly when server terminates socket
        res.resume();
        resolve({ req, res, closedPromise });
      });
      req.once("error", reject);
    });

  try {
    const address = await server.app.listen({ port: 0, host: "127.0.0.1" });

    const setupRes = await server.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "alice", password: "Password123!" },
    });
    assert.equal(setupRes.statusCode, 201);
    const cookieA = extractCookieHeader(setupRes.headers["set-cookie"]);

    const loginB = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "Password123!" },
    });
    assert.equal(loginB.statusCode, 200);
    const cookieB = extractCookieHeader(loginB.headers["set-cookie"]);

    const sseA = await openSse(address, cookieA);
    const sseB = await openSse(address, cookieB);
    assert.equal(sseA.res.statusCode, 200);
    assert.equal(sseB.res.statusCode, 200);

    // Wait briefly for initial heartbeat
    await new Promise((r) => setTimeout(r, 30));

    // Logout session A -> SSE A must close promptly, SSE B must remain open
    const logoutRes = await server.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: cookieA },
    });
    assert.equal(logoutRes.statusCode, 200);

    const aClosed = await Promise.race([
      sseA.closedPromise.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 1000)),
    ]);
    assert.equal(aClosed, true);

    // Give event loop a tick and verify SSE B is still open
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sseB.res.destroyed, false);
    assert.equal(sseB.res.complete, false);

    sseB.req.on("error", () => {});
    sseB.req.destroy();
  } finally {
    await server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
