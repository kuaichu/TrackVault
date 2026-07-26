import { readStoredVerifiedIdentityState, type VerifiedIdentityState } from "./account-session-snapshot.js";
import { resolveDataScopeId } from "./data-scope.js";
import { getRequiredClientSessionId } from "./request-context.js";
import { getSettings } from "./settings-store.js";

export type BackgroundJobOwnerResolverDependencies = {
  getClientSessionId: () => string;
  getCredentials: () => Promise<{ neteaseCookie: string; qqMusicCookie: string }>;
  readVerifiedIdentityState: (credentials: { neteaseCookie: string; qqMusicCookie: string }) => Promise<VerifiedIdentityState>;
};

export function createBackgroundJobOwnerResolver(dependencies: BackgroundJobOwnerResolverDependencies) {
  return async function resolveBackgroundJobOwner() {
    const clientSessionId = dependencies.getClientSessionId();
    const credentials = await dependencies.getCredentials();
    const identityState = await dependencies.readVerifiedIdentityState(credentials);
    return resolveDataScopeId({
      session: identityState.session,
      qqMusicUin: identityState.qqMusicUin,
      clientSessionId
    });
  };
}

export const getBackgroundJobOwnerKey = createBackgroundJobOwnerResolver({
  getClientSessionId: getRequiredClientSessionId,
  getCredentials: async () => {
    const settings = await getSettings();
    return {
      neteaseCookie: settings.neteaseCookie,
      qqMusicCookie: settings.qqMusicCookie ?? ""
    };
  },
  readVerifiedIdentityState: readStoredVerifiedIdentityState
});
