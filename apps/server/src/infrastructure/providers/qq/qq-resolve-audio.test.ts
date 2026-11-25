import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../../domain/errors.js";
import type { ProviderAuthContext } from "../../../domain/ports/music-provider.js";
import { SafeHttpClient } from "../../security/safe-http-client.js";
import { QqMusicAdapter } from "./qq-adapter.js";

const qqAuth: ProviderAuthContext = {
  platform: "qq",
  cookie: "uin=10001; qm_keyst=valid_key",
  scopeKey: "user-qq-test",
};

test("QqMusicAdapter.resolveAudio infers real lossy spec & 30s duration on isTrialUrl instead of misreporting Hi-Res FLAC", async () => {
  const http = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          code: 0,
          req_0: {
            code: 0,
            data: {
              sip: ["http://ws.stream.qqmusic.qq.com/"],
              midurlinfo: [
                {
                  filename: "RS01001.flac",
                  purl: "",
                  opi30surl: "O4M0001trial.m4a?guid=1&vkey=abc",
                  result: 104003,
                },
                {
                  filename: "F000001.flac",
                  purl: "",
                  opi30surl: "O4M0001trial.m4a?guid=1&vkey=abc",
                  result: 104003,
                },
                {
                  filename: "M800001.mp3",
                  purl: "",
                  opi30surl: "RS02001trial.mp3?guid=1&vkey=abc",
                  result: 104003,
                },
                {
                  filename: "M500001.mp3",
                  purl: "",
                  opi30surl: "RS02001trial.mp3?guid=1&vkey=abc",
                  result: 104003,
                },
                {
                  filename: "C400001.m4a",
                  purl: "",
                  opi30surl: "O4M0001trial.m4a?guid=1&vkey=abc",
                  result: 104003,
                },
              ],
            },
          },
        }),
        { status: 200 },
      ),
  });

  try {
    const adapter = new QqMusicAdapter(http);
    const hiresTrial = await adapter.resolveAudio(
      { id: "001", durationSeconds: 245 },
      "hires",
      "playback",
      qqAuth,
    );
    assert.equal(hiresTrial.trial, true);
    assert.equal(hiresTrial.format, "m4a");
    assert.equal(hiresTrial.bitrate, 96_000);
    assert.equal(hiresTrial.level, "standard");
    assert.equal(hiresTrial.durationSeconds, 30);
    assert.equal(hiresTrial.downgraded, true);
    assert.ok(hiresTrial.url.startsWith("https://ws.stream.qqmusic.qq.com/O4M0001trial.m4a"));

    const standardTrial = await adapter.resolveAudio(
      { id: "001", durationSeconds: 245 },
      "standard",
      "playback",
      qqAuth,
    );
    assert.equal(standardTrial.trial, true);
    assert.equal(standardTrial.format, "mp3");
    assert.equal(standardTrial.bitrate, 128_000);
    assert.equal(standardTrial.level, "standard");
    assert.equal(standardTrial.durationSeconds, 30);
    assert.equal(standardTrial.downgraded, false);
    assert.ok(standardTrial.url.startsWith("https://ws.stream.qqmusic.qq.com/RS02001trial.mp3"));
  } finally {
    http.close();
  }
});

test("QqMusicAdapter.resolveAudio prunes tiers via availableLevels and resolves in a single batch CgiGetVkey call", async () => {
  const sentFilenames: string[][] = [];
  const http = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as {
        req_0?: { param?: { filename?: string[] } };
      };
      sentFilenames.push(parsed.req_0?.param?.filename ?? []);
      return new Response(
        JSON.stringify({
          code: 0,
          req_0: {
            code: 0,
            data: {
              sip: ["https://ws.stream.qqmusic.qq.com/"],
              midurlinfo: [
                { filename: "M800002.mp3", purl: "", result: 104003 },
                { filename: "M500002.mp3", purl: "M500002.mp3?vkey=ok", result: 0 },
                { filename: "C400002.m4a", purl: "C400002.m4a?vkey=ok", result: 0 },
              ],
            },
          },
        }),
        { status: 200 },
      );
    },
  });

  try {
    const adapter = new QqMusicAdapter(http);
    const resolved = await adapter.resolveAudio(
      { id: "002", durationSeconds: 200, availableLevels: ["standard", "exhigh"] },
      "hires",
      "playback",
      qqAuth,
    );
    assert.equal(sentFilenames.length, 1);
    assert.deepEqual(sentFilenames[0], ["M800002.mp3", "M500002.mp3", "C400002.m4a"]);
    assert.equal(resolved.trial, false);
    assert.equal(resolved.level, "standard");
    assert.equal(resolved.format, "mp3");
    assert.equal(resolved.bitrate, 128_000);
    assert.equal(resolved.downgraded, true);
  } finally {
    http.close();
  }
});

test("QqMusicAdapter.resolveAudio short-circuits immediately on CREDENTIAL_INVALID without retrying remaining tiers", async () => {
  let requests = 0;
  const http = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify({ code: 0, req_0: { code: 1000 } }), { status: 200 });
    },
  });

  try {
    const adapter = new QqMusicAdapter(http);
    await assert.rejects(
      () => adapter.resolveAudio({ id: "003" }, "hires", "playback", qqAuth),
      (err: unknown) => err instanceof AppError && err.code === "CREDENTIAL_INVALID",
    );
    assert.equal(requests, 1);
  } finally {
    http.close();
  }
});
