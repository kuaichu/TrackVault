import { buildServer } from "./app.js";
import { loadServerConfig } from "./config/env.js";

const config = loadServerConfig();
const server = await buildServer({ config });

const shutdown = async (signal: string) => {
  console.log(`[TrackVault v2] Received ${signal}, shutting down gracefully...`);
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await server.app.listen({ host: config.host, port: config.port });
console.log(`[TrackVault v2] Server listening on http://${config.host}:${config.port}`);
