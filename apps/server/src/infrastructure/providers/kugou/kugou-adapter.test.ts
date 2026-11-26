import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import zlib from "node:zlib";
import { AppError } from "../../../domain/errors.js";
import type { ProviderAuthContext } from "../../../domain/ports/music-provider.js";
import { createMockSafeHttp } from "../../../test-utils/fixtures.js";
import { SqliteClient } from "../../db/client.js";
import { CredentialRepository } from "../../db/repositories/credential-repository.js";
import { AesGcmCredentialVault } from "../../security/credential-vault.js";
import { KugouMusicAdapter } from "./kugou-adapter.js";
import { decodeKrcContent, parseKrcLyrics } from "./kugou-crypto.js";

function encodeSampleKrc(krcPlain: string): string {
  const key = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
  const deflated = zlib.deflateSync(Buffer.from(krcPlain, "utf8"));
  const xored = Buffer.from(deflated);
  for (let i = 0; i < xored.length; i += 1) {
    xored[i] = (xored[i] ?? 0) ^ (key[i % key.length] ?? 0);
  }
  return Buffer.concat([Buffer.from("krc1"), xored]).toString("base64");
}

test("KRC lyric decoder & parser decodes XOR+zlib payload and extracts bilingual translations", () => {
  const langJson = JSON.stringify({
    content: [
      {
        type: 1,
        lyricContent: [["故事的小黄花"], ["从出生那年就飘着"]],
      },
    ],
  });
  const rawKrc = [
    "[id:$00000000]",
    `[language:${Buffer.from(langJson, "utf8").toString("base64")}]`,
    "[12500,3200]<0,400,0>故<400,400,0>事<800,400,0>的小黄花",
    "[16000,4100]<0,500,0>从出生那年就飘着",
  ].join("\n");

  const encoded = encodeSampleKrc(rawKrc);
  const decoded = decodeKrcContent(encoded);
  assert.equal(decoded, rawKrc);

  const lines = parseKrcLyrics(decoded);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], {
    time: 12.5,
    text: "故事的小黄花",
    translation: "故事的小黄花",
  });
  assert.deepEqual(lines[1], {
    time: 16,
    text: "从出生那年就飘着",
    translation: "从出生那年就飘着",
  });
});

test("KugouMusicAdapter supports selectable QR channels (kg_lite, kg_std, kg_wx_lite) and preserves edition in normalizedCookie", async () => {
  const http = createMockSafeHttp(async (url, _init) => {
    const parsed = new URL(String(url));

    if (parsed.pathname === "/v2/qrcode") {
      const qrTxt = parsed.searchParams.get("qrcode_txt") ?? "";
      const isStd = qrTxt.includes("appid=1005");
      return new Response(
        JSON.stringify({
          status: 1,
          data: {
            qrcode: isStd ? "qr-std-key" : "qr-lite-key",
            qrcode_img:
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          },
        }),
        { status: 200 },
      );
    }

    if (parsed.pathname === "/v2/get_userinfo_qrcode") {
      const appid = parsed.searchParams.get("appid");
      return new Response(
        JSON.stringify({
          status: 1,
          data: {
            status: 4,
            userid: appid === "1005" ? 88001005 : 88003116,
            token: appid === "1005" ? "tok-std" : "tok-lite",
            nickname: appid === "1005" ? "StdUser" : "LiteUser",
            pic: "http://imge.kugou.com/kugouicon/165/20260321/avatar.jpg",
            vip_type: appid === "1005" ? 6 : 0,
          },
        }),
        { status: 200 },
      );
    }

    if (parsed.pathname === "/risk/v3/r_register_dev") {
      return new Response("fallback", { status: 500 });
    }

    if (parsed.pathname === "/v3/get_my_info") {
      const appid = parsed.searchParams.get("appid");
      return new Response(
        JSON.stringify({
          status: 1,
          data: {
            nickname: appid === "1005" ? "StdUser" : "LiteUser",
            pic: "http://imge.kugou.com/kugouicon/165/20260321/avatar.jpg",
            vip_type: appid === "1005" ? 6 : 0,
            y_type: appid === "3116" ? 1 : 0,
          },
        }),
        { status: 200 },
      );
    }

    if (parsed.pathname === "/v1/get_union_vip") {
      return new Response(
        JSON.stringify({
          status: 1,
          data: {
            is_vip: 1,
            vip_end_time: "2027-01-01 00:00:00",
          },
        }),
        { status: 200 },
      );
    }

    if (parsed.hostname === "api.weixin.qq.com" && parsed.pathname === "/cgi-bin/token") {
      assert.equal(parsed.searchParams.get("appid"), "wx72b795aca60ad321");
      return new Response(JSON.stringify({ access_token: "wx-at" }), { status: 200 });
    }

    if (parsed.hostname === "api.weixin.qq.com" && parsed.pathname === "/cgi-bin/ticket/getticket") {
      return new Response(JSON.stringify({ errcode: 0, ticket: "wx-ticket" }), { status: 200 });
    }

    if (parsed.hostname === "open.weixin.qq.com" && parsed.pathname === "/connect/sdk/qrconnect") {
      return new Response(
        JSON.stringify({
          errcode: 0,
          uuid: "wx-uuid-lite",
          qrcode: { qrcodebase64: "AA==" },
        }),
        { status: 200 },
      );
    }

    if (parsed.hostname === "long.open.weixin.qq.com") {
      return new Response(JSON.stringify({ wx_errcode: 405, wx_code: "wx-oauth-code" }), { status: 200 });
    }

    if (parsed.hostname === "api.weixin.qq.com" && parsed.pathname === "/sns/oauth2/access_token") {
      return new Response(JSON.stringify({ access_token: "wx-user-token", openid: "wx-openid-1" }), {
        status: 200,
      });
    }

    if (parsed.pathname === "/v6/login_by_openplat") {
      return new Response(
        JSON.stringify({
          status: 1,
          data: {
            userid: 99003116,
            token: "wx-lite-direct-token",
            nickname: "WxConceptUser",
            vip_type: 1,
          },
        }),
        { status: 200 },
      );
    }

    return new Response(JSON.stringify({ status: 1 }), { status: 200 });
  });

  const adapter = new KugouMusicAdapter(http, { seedGuid: "test-guid" });
  try {
    assert.deepEqual(adapter.capabilities.qrLoginChannels, ["kg_lite", "kg_std", "kg_wx_lite", "kg_wx_std"]);

    // 1. Concept Edition (`kg_lite`) QR
    const liteStart = await adapter.startQrLogin("user-1", { channel: "kg_lite" });
    assert.equal(liteStart.channel, "kg_lite");
    const liteCheck = await adapter.checkQrLogin("user-1", liteStart.key);
    assert.equal(liteCheck.status, "confirmed");
    assert.equal(liteCheck.verification?.ok, true);
    assert.equal(liteCheck.verification?.accountUid, "88003116");
    assert.match(liteCheck.verification?.displayName ?? "", /LiteUser \(概念版\)/);
    assert.match(liteCheck.verification?.normalizedCookie ?? "", /kg_edition=lite/);

    // 2. Standard Edition (`kg_std`) QR
    const stdStart = await adapter.startQrLogin("user-1", { channel: "kg_std" });
    assert.equal(stdStart.channel, "kg_std");
    const stdCheck = await adapter.checkQrLogin("user-1", stdStart.key);
    assert.equal(stdCheck.status, "confirmed");
    assert.equal(stdCheck.verification?.ok, true);
    assert.equal(stdCheck.verification?.accountUid, "88001005");
    assert.match(stdCheck.verification?.displayName ?? "", /StdUser \(标准版\)/);
    assert.match(stdCheck.verification?.normalizedCookie ?? "", /kg_edition=standard/);

    // 3. WeChat Concept Edition (`kg_wx_lite`) QR
    const wxStart = await adapter.startQrLogin("user-1", { channel: "kg_wx_lite" });
    assert.equal(wxStart.channel, "kg_wx_lite");
    const wxCheck = await adapter.checkQrLogin("user-1", wxStart.key);
    assert.equal(wxCheck.status, "confirmed");
    assert.equal(wxCheck.verification?.ok, true);
    assert.equal(wxCheck.verification?.accountUid, "99003116");
    assert.match(wxCheck.verification?.normalizedCookie ?? "", /kg_edition=lite/);
  } finally {
    adapter.close();
    http.close();
  }
});

test("KugouMusicAdapter search, playlist read/create, audio resolution (HTTPS upgrade), and lyrics work end-to-end", async () => {
  const sampleHash = "B3A52A7A958BF0AED0EBFBA2E9A818B7";
  const flacHash = "0A69169202DE95AAF24A9944CCF0730D";

  const http = createMockSafeHttp(async (url) => {
    const parsed = new URL(String(url));

    if (parsed.pathname === "/v2/search/song") {
      return new Response(
        JSON.stringify({
          status: 1,
          data: {
            lists: [
              {
                SongName: "<em>晴天</em>",
                SingerName: "周杰伦",
                Singers: [{ id: 3520, name: "周杰伦" }],
                FileHash: sampleHash,
                HQFileHash: "1B56126A8A03924F1DD066259C095CBC",
                SQFileHash: flacHash,
                AlbumName: "叶惠美",
                AlbumID: "966846",
                MixSongID: 32100650,
                Duration: 269,
                Privilege: 10,
                PayType: 3,
                Image: "http://imge.kugou.com/stdmusic/{size}/20230920/20230920142503632013.jpg",
              },
            ],
          },
        }),
        { status: 200 },
      );
    }

    if (parsed.pathname === "/v2/get_res_privilege/lite") {
      return new Response(
        JSON.stringify({
          status: 1,
          data: [
            {
              hash: sampleHash.toLowerCase(),
              name: "周杰伦 - 晴天",
              album_id: 966846,
              album_audio_id: 32100650,
              relate_goods: [
                { hash: sampleHash, level: 2, quality: "128" },
                { hash: flacHash, level: 5, quality: "flac" },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    }

    if (parsed.pathname === "/risk/v3/r_register_dev") {
      return new Response("fallback", { status: 500 });
    }

    if (parsed.pathname === "/v5/url") {
      const qHash = parsed.searchParams.get("hash")?.toUpperCase();
      if (qHash === flacHash) {
        return new Response(
          JSON.stringify({
            status: 1,
            extName: "flac",
            bitRate: 960_000,
            timeLength: 269,
            url: ["http://fsandroid.tx.kugou.com/20261126/qingtian.flac"],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ status: 2, fail_process: ["pkg"] }), { status: 200 });
    }

    if (parsed.pathname === "/cloudlist.service/v5/add_list") {
      return new Response(
        JSON.stringify({
          status: 1,
          data: { info: { listid: 501, global_collection_id: "collection_3_1001_501_0" } },
        }),
        { status: 200 },
      );
    }

    if (parsed.pathname === "/cloudlist.service/v6/add_song") {
      return new Response(JSON.stringify({ status: 1, error_code: 0 }), { status: 200 });
    }

    if (parsed.hostname === "lyrics.kugou.com" && parsed.pathname === "/v1/search") {
      return new Response(JSON.stringify({ candidates: [{ id: "lyr-1", accesskey: "acc-1" }] }), {
        status: 200,
      });
    }

    if (parsed.hostname === "lyrics.kugou.com" && parsed.pathname === "/download") {
      return new Response(
        JSON.stringify({
          contenttype: 0,
          content: encodeSampleKrc("[0,2000]<0,500,0>晴天歌词测试"),
        }),
        { status: 200 },
      );
    }

    return new Response(JSON.stringify({ status: 1 }), { status: 200 });
  });

  const adapter = new KugouMusicAdapter(http, { seedGuid: "catalog-test" });
  const auth: ProviderAuthContext = {
    platform: "kugou",
    cookie: "userid=1001; token=valid-tok; kg_edition=lite; dfid=real-dfid-123",
    scopeKey: "u-kg",
    vipEnabled: true,
  };

  try {
    const songs = await adapter.searchTracks("晴天", auth, 10);
    assert.equal(songs.length, 1);
    assert.equal(songs[0]?.id, sampleHash);
    assert.equal(songs[0]?.title, "晴天");
    assert.equal(songs[0]?.coverUrl, "https://imge.kugou.com/stdmusic/400/20230920/20230920142503632013.jpg");
    assert.deepEqual(
      songs[0]?.availableQualities.map((q) => q.level),
      ["standard", "exhigh", "lossless"],
    );

    const audio = await adapter.resolveAudio(
      { id: sampleHash, mediaId: songs[0]?.mediaId, availableLevels: ["standard", "lossless"] },
      "lossless",
      "download",
      auth,
    );
    assert.equal(audio.url, "https://fsandroid.tx.kugou.com/20261126/qingtian.flac");
    assert.equal(audio.format, "flac");
    assert.equal(audio.level, "lossless");
    assert.equal(audio.trial, false);

    const lyrics = await adapter.getLyrics(sampleHash, songs[0]?.mediaId, auth);
    assert.equal(lyrics.source, "kugou");
    assert.equal(lyrics.lines[0]?.text, "晴天歌词测试");

    const created = await adapter.createPlaylistWithTracks("迁移测试歌单", [sampleHash], auth);
    assert.equal(created.playlistId, "collection_3_1001_501_0");
    assert.equal(created.addedCount, 1);
  } finally {
    adapter.close();
    http.close();
  }
});

test("SQLite Migration v3 seamlessly upgrades v2 database and enables kugou credentials while preserving existing rows", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-mig-v3-"));
  const dbPath = path.join(tmpDir, "legacy-v2.db");

  // Seed a v2-only schema database manually
  const rawDb = new DatabaseSync(dbPath);
  rawDb.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'init_schema', 1), (2, 'p1_revisions_and_job_columns', 2);
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      trusted_fallback INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    INSERT INTO users (id, username, password_hash, role, trusted_fallback, created_at)
    VALUES ('u1', 'admin', 'hash', 'admin', 1, 100);

    CREATE TABLE platform_credentials (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform TEXT NOT NULL CHECK (platform IN ('netease', 'qq')),
      encrypted_cookie TEXT NOT NULL, account_uid TEXT, display_name TEXT, avatar_url TEXT,
      vip_enabled INTEGER NOT NULL DEFAULT 0, vip_expire_at INTEGER, verified_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, platform)
    );
    CREATE TABLE system_fallback_credentials (
      platform TEXT PRIMARY KEY CHECK (platform IN ('netease', 'qq')),
      encrypted_cookie TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );
  `);
  const vault = new AesGcmCredentialVault(Buffer.alloc(32, 9));
  const encQq = vault.encrypt("uin=12345; qm_keyst=keep-me");
  rawDb
    .prepare(
      "INSERT INTO platform_credentials (user_id, platform, encrypted_cookie, account_uid, display_name, vip_enabled, verified_at) VALUES ('u1', 'qq', ?, '12345', 'QQ User', 1, 500)",
    )
    .run(encQq);
  rawDb.close();

  // Open via SqliteClient -> runs Migration v3 automatically
  const sqlite = new SqliteClient(dbPath);
  try {
    const repo = new CredentialRepository(sqlite, vault);
    assert.equal(repo.getDecryptedCookie("u1", "qq"), "uin=12345; qm_keyst=keep-me");

    const savedKg = repo.saveBinding("u1", {
      platform: "kugou",
      cookie: "userid=888; token=kg-sec; kg_edition=lite",
      accountUid: "888",
      displayName: "酷狗测试 (概念版)",
      avatarUrl: null,
      vipEnabled: true,
      vipExpireAt: null,
    });
    assert.equal(savedKg.connected, true);

    const allViews = repo.listBindingViews("u1");
    assert.equal(allViews.qq.connected, true);
    assert.equal(allViews.kugou.connected, true);
    assert.equal(allViews.netease.connected, false);

    // Still rejects unknown platforms
    assert.throws(() => {
      sqlite.db
        .prepare(
          "INSERT INTO system_fallback_credentials (platform, encrypted_cookie, enabled, updated_at) VALUES ('spotify', 'x', 1, 1)",
        )
        .run();
    });
  } finally {
    sqlite.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("KugouMusicAdapter surfaces HTTP 401/403 on authenticated requests as CREDENTIAL_INVALID", async () => {
  const http = createMockSafeHttp(async () => new Response("Unauthorized", { status: 401 }));
  const adapter = new KugouMusicAdapter(http);
  const auth: ProviderAuthContext = {
    platform: "kugou",
    cookie: "userid=1001; token=expired-tok; kg_edition=lite",
    scopeKey: "u-exp",
  };
  try {
    await assert.rejects(
      () => adapter.getUserPlaylists(auth),
      (err: unknown) => err instanceof AppError && err.code === "CREDENTIAL_INVALID",
    );
  } finally {
    adapter.close();
    http.close();
  }
});
