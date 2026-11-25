import type { ProviderAuthContext } from "../../../domain/ports/music-provider.js";

/**
 * Isolates authenticated upstream responses by user scopeKey while allowing
 * unauthenticated requests to share the "public" cache scope.
 */
export function resolveProviderCacheScope(
  auth: Pick<ProviderAuthContext, "scopeKey" | "cookie">,
  hasCookie?: boolean,
): string {
  const authed = hasCookie !== undefined ? hasCookie : Boolean(auth.cookie?.trim());
  return authed ? auth.scopeKey : "public";
}
