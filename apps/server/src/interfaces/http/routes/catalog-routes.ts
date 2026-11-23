import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { EntitySearchTypeSchema, MusicPlatformSchema, PlaylistSortSchema, ProviderModeSchema } from "#shared";
import type { CatalogService } from "../../../application/catalog/catalog-service.js";
import type { ProviderRegistry } from "../../../domain/ports/music-provider.js";
import { requireActor } from "../auth-plugin.js";

export function registerCatalogRoutes(
  app: FastifyInstance,
  deps: { catalogService: CatalogService; providers: ProviderRegistry },
): void {
  const { catalogService, providers } = deps;

  app.get("/api/capabilities", async (request) => {
    requireActor(request);
    return { capabilities: providers.listCapabilities() };
  });

  app.get("/api/search", async (request) => {
    const actor = requireActor(request);
    const query = z
      .object({
        q: z.string().trim().max(200).default(""),
        mode: ProviderModeSchema.default("netease"),
      })
      .parse(request.query);

    const { results, warnings } = await catalogService.search(actor, query.q, query.mode);
    return { results, mode: query.mode, warnings };
  });

  app.get("/api/search/entities", async (request) => {
    const actor = requireActor(request);
    const query = z
      .object({
        q: z.string().trim().max(200).default(""),
        mode: ProviderModeSchema.default("aggregate"),
        type: EntitySearchTypeSchema.default("artist"),
      })
      .parse(request.query);

    return catalogService.searchEntities(actor, query.q, query.mode, query.type);
  });

  app.get("/api/discover", async (request) => {
    const actor = requireActor(request);
    const query = z.object({ platform: MusicPlatformSchema.optional() }).parse(request.query);
    const songs = await catalogService.getDiscover(actor, query.platform);
    return { songs };
  });

  app.get("/api/discover/playlists", async (request) => {
    const actor = requireActor(request);
    const query = z.object({ platform: MusicPlatformSchema.default("netease") }).parse(request.query);
    const playlists = await catalogService.getRecommendedPlaylists(actor, query.platform);
    return { playlists };
  });

  app.get("/api/charts", async (request) => {
    const actor = requireActor(request);
    const query = z.object({ platform: MusicPlatformSchema.default("netease") }).parse(request.query);
    const charts = await catalogService.getCharts(actor, query.platform);
    return { charts };
  });

  app.get("/api/charts/:platform/:id", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ platform: MusicPlatformSchema, id: z.string().min(1) }).parse(request.params);
    return catalogService.getChartDetail(actor, params.platform, params.id);
  });

  app.get("/api/artists/:platform/:id", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ platform: MusicPlatformSchema, id: z.string().min(1) }).parse(request.params);
    const artist = await catalogService.getArtistDetail(actor, params.platform, params.id);
    return { artist };
  });

  app.get("/api/albums/:platform/:id", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ platform: MusicPlatformSchema, id: z.string().min(1) }).parse(request.params);
    const album = await catalogService.getAlbumDetail(actor, params.platform, params.id);
    return { album };
  });

  app.get("/api/fm", async (request) => {
    const actor = requireActor(request);
    const songs = await catalogService.getPersonalFm(actor);
    return { songs };
  });

  app.get("/api/recommend/daily", async (request) => {
    const actor = requireActor(request);
    return { songs: await catalogService.getDailyRecommend(actor) };
  });

  app.get("/api/cloud/songs", async (request) => {
    const actor = requireActor(request);
    return { songs: await catalogService.getCloudTracks(actor) };
  });

  app.get("/api/playlists", async (request) => {
    const actor = requireActor(request);
    const query = z.object({ platform: MusicPlatformSchema.default("netease") }).parse(request.query);
    return { playlists: await catalogService.getUserPlaylists(actor, query.platform) };
  });

  app.post("/api/playlists/:platform", async (request, reply) => {
    const actor = requireActor(request);
    const params = z.object({ platform: MusicPlatformSchema }).parse(request.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(120),
        trackIds: z.array(z.string().min(1)).max(200).default([]),
      })
      .parse(request.body);
    const result = await catalogService.createPlaylist(actor, params.platform, body.name, body.trackIds);
    return reply.code(201).send(result);
  });

  app.get("/api/playlists/:platform/:id/songs", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ platform: MusicPlatformSchema, id: z.string().min(1) }).parse(request.params);
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        keyword: z.string().max(120).optional(),
        sort: PlaylistSortSchema.default("default"),
      })
      .parse(request.query);

    return catalogService.getPlaylistTracks(actor, params.platform, params.id, query);
  });

  app.post("/api/playlists/:platform/:id/tracks", async (request, reply) => {
    const actor = requireActor(request);
    const params = z.object({ platform: MusicPlatformSchema, id: z.string().min(1) }).parse(request.params);
    const body = z.object({ trackIds: z.array(z.string().min(1)).min(1).max(200) }).parse(request.body);
    const result = await catalogService.addTracksToPlaylist(actor, params.platform, params.id, body.trackIds);
    return reply.code(201).send(result);
  });

  app.delete("/api/playlists/:platform/:id/tracks", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ platform: MusicPlatformSchema, id: z.string().min(1) }).parse(request.params);
    const body = z.object({ trackIds: z.array(z.string().min(1)).min(1).max(200) }).parse(request.body);
    return catalogService.removeTracksFromPlaylist(actor, params.platform, params.id, body.trackIds);
  });

  app.get("/api/lyrics/:platform/:id", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ platform: MusicPlatformSchema, id: z.string().min(1) }).parse(request.params);
    const query = z.object({ mediaId: z.string().max(128).optional() }).parse(request.query);
    return { lyrics: await catalogService.getLyrics(actor, params.platform, params.id, query.mediaId) };
  });

  app.get("/api/comments/:platform/:id", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ platform: MusicPlatformSchema, id: z.string().min(1) }).parse(request.params);
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(5).max(50).default(20),
      })
      .parse(request.query);
    return catalogService.getComments(actor, params.platform, params.id, query.page, query.limit);
  });

  app.post("/api/comments/:platform/:id/:commentId/like", async (request) => {
    const actor = requireActor(request);
    const params = z
      .object({
        platform: MusicPlatformSchema,
        id: z.string().min(1),
        commentId: z.string().min(1),
      })
      .parse(request.params);
    const body = z.object({ liked: z.boolean() }).parse(request.body);
    return catalogService.setCommentLiked(actor, params.platform, params.id, params.commentId, body.liked);
  });

  app.get("/api/likes/:platform", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ platform: MusicPlatformSchema }).parse(request.params);
    return { ids: await catalogService.getLikedSongIds(actor, params.platform) };
  });

  app.get("/api/likes/:platform/:id", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ platform: MusicPlatformSchema, id: z.string().min(1) }).parse(request.params);
    return { liked: await catalogService.isSongLiked(actor, params.platform, params.id) };
  });

  app.post("/api/likes/:platform/:id", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ platform: MusicPlatformSchema, id: z.string().min(1) }).parse(request.params);
    const body = z.object({ liked: z.boolean() }).parse(request.body);
    return catalogService.toggleSongLike(actor, params.platform, params.id, body.liked);
  });
}
