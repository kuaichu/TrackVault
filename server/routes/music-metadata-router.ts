import express from "express";
import type { AlbumProfile, ArtistProfile } from "../types.js";

export type MusicMetadataRouterDependencies = {
  resolveArtistIdByName: (name: string) => Promise<{ id: string; name: string }>;
  getArtistProfile: (artistId: string) => Promise<ArtistProfile>;
  getAlbumProfile: (albumId: string) => Promise<AlbumProfile>;
};

export function createMusicMetadataRouter(dependencies: MusicMetadataRouterDependencies) {
  const router = express.Router();

  router.get("/api/artists/resolve/by-name", async (request, response) => {
    const name = typeof request.query.name === "string" ? request.query.name : "";

    try {
      response.json(await dependencies.resolveArtistIdByName(name));
    } catch (error) {
      response.status(404).json({
        message: error instanceof Error ? error.message : "解析歌手失败"
      });
    }
  });

  router.get("/api/artists/:id", async (request, response) => {
    try {
      response.json({ artist: await dependencies.getArtistProfile(request.params.id) });
    } catch (error) {
      response.status(502).json({
        message: error instanceof Error ? error.message : "获取歌手信息失败"
      });
    }
  });

  router.get("/api/albums/:id", async (request, response) => {
    try {
      response.json({ album: await dependencies.getAlbumProfile(request.params.id) });
    } catch (error) {
      response.status(502).json({
        message: error instanceof Error ? error.message : "获取专辑信息失败"
      });
    }
  });

  return router;
}
