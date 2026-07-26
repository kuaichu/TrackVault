import { readStoredAccountSession } from "./account-session-snapshot.js";
import { resolveDataScopeId } from "./data-scope.js";
import { getRequiredClientSessionId } from "./request-context.js";
import { getSettings } from "./settings-store.js";
import type { AuthSession } from "./types.js";

export type BackgroundJobOwnerResolverDependencies = {
  getClientSessionId: () => string;
  readStoredSession: () => Promise<AuthSession>;
  getQqMusicCookie: () => Promise<string>;
};

export function createBackgroundJobOwnerResolver(dependencies: BackgroundJobOwnerResolverDependencies) {
  return async function resolveBackgroundJobOwner() {
    const clientSessionId = dependencies.getClientSessionId();
    const [session, qqMusicCookie] = await Promise.all([
      dependencies.readStoredSession(),
      dependencies.getQqMusicCookie()
    ]);
    return resolveDataScopeId({ session, qqMusicCookie, clientSessionId });
  };
}

export const getBackgroundJobOwnerKey = createBackgroundJobOwnerResolver({
  getClientSessionId: getRequiredClientSessionId,
  readStoredSession: readStoredAccountSession,
  getQqMusicCookie: async () => (await getSettings()).qqMusicCookie ?? ""
});
