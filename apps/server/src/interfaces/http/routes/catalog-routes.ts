import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MusicPlatformSchema, PlaylistSortSchema, ProviderModeSchema } from "#shared";
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

  app.get("/api/discover", async (request) => {
    const actor = requireActor(request);
    const query = z.object({ platform: MusicPlatformSchema.optional() }).parse(request.query);
    const songs = await catalogService.getDiscover(actor, query.platform);
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
