import assert from "node:assert/strict";
import test from "node:test";
import { buildNeteaseImportedPlaylistAudit, getNeteaseTrackUnusableReason } from "./netease-import-audit.js";
import type { ProviderTrack } from "./types.js";

const unavailableTrack = {
  id: 3348129273,
  name: "一生一念",
  ar: [{ name: "段奥娟" }],
  al: { name: "成何体统 影视原声带" },
  dt: 240000,
  noCopyrightRcmd: {
    type: 2,
    typeDesc: "其它版本可播"
  }
};

test("getNeteaseTrackUnusableReason recognizes imported tracks with alternate playable versions", () => {
  const reason = getNeteaseTrackUnusableReason(unavailableTrack, {
    id: unavailableTrack.id,
    st: -200,
    pl: 0,
    dl: 0
  });

  assert.equal(reason, "其它版本可播");
});

test("buildNeteaseImportedPlaylistAudit selects same-title playable replacements for text import", async () => {
  const candidates: ProviderTrack[] = [
    {
      provider: "netease",
      id: String(unavailableTrack.id),
      title: "一生一念",
      artists: ["段奥娟"],
      album: "成何体统 影视原声带"
    },
    {
      provider: "netease",
      id: "replacement-1",
      title: "一生一念",
      artists: ["李常超"],
      album: "一生一念"
    }
  ];

  const audit = await buildNeteaseImportedPlaylistAudit({
    playlistId: "liked",
    playlistName: "我喜欢的音乐",
    tracks: [
      {
        track: unavailableTrack,
        privilege: {
          id: unavailableTrack.id,
          st: -200,
          pl: 0,
          dl: 0
        }
      }
    ],
    searchCandidates: async () => candidates,
    checkCandidateAvailability: async () => null
  });

  assert.equal(audit.summary.suspect, 1);
  assert.equal(audit.summary.replaceable, 1);
  assert.equal(audit.items[0].status, "replaceable");
  assert.equal(audit.items[0].selectedCandidate?.targetTrackId, "replacement-1");
  assert.match(audit.textPlaylist, /一生一念 - 李常超/);
});

test("buildNeteaseImportedPlaylistAudit does not pick accompaniment versions when the source is not accompaniment", async () => {
  const audit = await buildNeteaseImportedPlaylistAudit({
    playlistId: "liked",
    playlistName: "我喜欢的音乐",
    tracks: [
      {
        track: {
          ...unavailableTrack,
          id: 1914933323,
          name: "雪龙吟",
          ar: [{ name: "张杰" }],
          al: { name: "雪龙吟" }
        },
        privilege: {
          id: 1914933323,
          st: -200,
          pl: 0,
          dl: 0
        }
      }
    ],
    searchCandidates: async () => [
      {
        provider: "netease",
        id: "accompaniment",
        title: "雪龙吟 (伴奏)",
        artists: ["张杰"],
        album: "雪龙吟",
        durationSeconds: 207
      },
      {
        provider: "netease",
        id: "clean",
        title: "雪龙吟",
        artists: ["包胡尔查"],
        album: "雪龙吟 (包胡尔查版)",
        durationSeconds: 210
      }
    ]
  });

  assert.equal(audit.items[0].selectedCandidate?.targetTrackId, "clean");
  assert.doesNotMatch(audit.textPlaylist, /伴奏/);
});

test("buildNeteaseImportedPlaylistAudit lists unusable tracks when no replacement is found", async () => {
  const audit = await buildNeteaseImportedPlaylistAudit({
    playlistId: "liked",
    playlistName: "我喜欢的音乐",
    tracks: [
      {
        track: {
          ...unavailableTrack,
          id: 2052404241,
          name: "完全没结果"
        },
        privilege: {
          id: 2052404241,
          st: -200,
          pl: 0,
          dl: 0
        }
      }
    ],
    searchCandidates: async () => []
  });

  assert.equal(audit.summary.unusable, 1);
  assert.equal(audit.items[0].status, "unusable");
  assert.match(audit.unusableText, /完全没结果 - 段奥娟/);
});
