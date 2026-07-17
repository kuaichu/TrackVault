export type ScopedHydrationDecision = {
  source: "remote" | "scoped-local";
  uploadScopedLocal: boolean;
};

export class ScopedWriteQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue(key: string, write: () => Promise<void>) {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(write);
    this.tails.set(key, next);
    return next.finally(() => {
      if (this.tails.get(key) === next) {
        this.tails.delete(key);
      }
    });
  }
}

export function getPlayerStateFingerprint(state: {
  currentTrack: { id: string; source?: string } | null;
  playQueue: Array<{ id: string; source?: string }>;
  playbackSeconds: number;
  volume: number;
  playbackMode?: string;
}) {
  return JSON.stringify({
    currentTrack: state.currentTrack ? [state.currentTrack.source ?? "", state.currentTrack.id] : null,
    playQueue: state.playQueue.map((song) => [song.source ?? "", song.id]),
    playbackSeconds: state.playbackSeconds,
    volume: state.volume,
    playbackMode: state.playbackMode ?? "sequential"
  });
}

export function getScopedStorageKey(baseKey: string, dataScopeId: string) {
  return `${baseKey}:scope:${encodeURIComponent(dataScopeId)}`;
}

export function shouldApplyScopedResult(capturedScope: string, currentScope: string | null | undefined) {
  return Boolean(currentScope && capturedScope === currentScope);
}

export function shouldPersistScopedState(input: {
  hydrated: boolean;
  capturedScope: string;
  currentScope: string | null | undefined;
}) {
  return input.hydrated && shouldApplyScopedResult(input.capturedScope, input.currentScope);
}

export function decideScopedHydration(input: {
  remoteSucceeded: boolean;
  remoteHasData: boolean;
  scopedLocalHasData: boolean;
}): ScopedHydrationDecision {
  if (input.remoteSucceeded && input.remoteHasData) {
    return { source: "remote", uploadScopedLocal: false };
  }

  if (input.scopedLocalHasData) {
    return {
      source: "scoped-local",
      uploadScopedLocal: input.remoteSucceeded
    };
  }

  return { source: "remote", uploadScopedLocal: false };
}

export function shouldMigrateLegacyData(input: {
  dataScopeId: string;
  migrationMarker: string | null;
  hasLegacyData: boolean;
}) {
  return Boolean(input.dataScopeId) && !input.migrationMarker && input.hasLegacyData;
}
