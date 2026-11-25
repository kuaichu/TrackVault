import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";
import type { JobView, Song, UserSettings, UserSummary } from "#shared";

export function makeTestSong(id: string, overrides: Partial<Song> = {}): Song {
  return {
    id,
    platform: "netease",
    title: `Song ${id}`,
    artist: `Artist ${id}`,
    album: `Album ${id}`,
    durationSeconds: 200,
    duration: "03:20",
    quality: "320K",
    availableQualities: [
      { level: "standard", label: "128K" },
      { level: "exhigh", label: "320K" },
      { level: "lossless", label: "FLAC" },
    ],
    ...overrides,
  };
}

export function makeTestJob(overrides: Partial<JobView> = {}): JobView {
  return {
    id: "job-1",
    kind: "download",
    status: "running",
    progress: 20,
    title: "测试任务",
    createdAt: 1000,
    updatedAt: 1000,
    downloadReady: false,
    artifactExpired: false,
    ...overrides,
  };
}

export function makeTestSettings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    providerMode: "netease",
    defaultPlaybackQuality: "exhigh",
    defaultDownloadQuality: "lossless",
    maxConcurrentDownloads: 2,
    startupView: "discover",
    ...overrides,
  };
}

export function makeTestUser(overrides: Partial<UserSummary> = {}): UserSummary {
  return {
    id: "u-test",
    username: "alice",
    role: "admin",
    trustedFallback: true,
    createdAt: 1,
    ...overrides,
  };
}

export function createControlledAudio() {
  const audio = document.createElement("audio");
  let paused = true;
  Object.defineProperty(audio, "paused", { get: () => paused, configurable: true });
  const playSpy = vi.spyOn(audio, "play").mockImplementation(async () => {
    paused = false;
  });
  vi.spyOn(audio, "pause").mockImplementation(() => {
    paused = true;
    audio.dispatchEvent(new Event("pause"));
  });
  vi.spyOn(audio, "load").mockImplementation(() => undefined);
  return {
    audio,
    playSpy,
    setPaused: (nextPaused: boolean) => {
      paused = nextPaused;
    },
  };
}

export class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  constructor(_url: string, _init?: EventSourceInit) {
    MockEventSource.instances.push(this);
  }

  emitOpen(): void {
    this.onopen?.(new Event("open"));
  }

  emitError(): void {
    this.onerror?.(new Event("error"));
  }

  emitMessage(data: Record<string, unknown>): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify({ timestamp: Date.now(), ...data }) }),
    );
  }

  close(): void {}
}

export function installMockEventSource(): () => void {
  const originalEventSource = globalThis.EventSource;
  MockEventSource.instances = [];
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  return () => {
    MockEventSource.instances = [];
    globalThis.EventSource = originalEventSource;
  };
}

export function createTestQueryClient(options?: {
  retry?: boolean | number;
  retryDelay?: number;
}): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: options?.retry ?? false,
        ...(options?.retryDelay !== undefined ? { retryDelay: options.retryDelay } : {}),
      },
    },
  });
}

export function createTestQueryWrapper(
  queryClient: QueryClient = createTestQueryClient(),
  options?: { withRouter?: boolean; initialEntries?: string[] },
) {
  const withRouter = options?.withRouter ?? true;
  const initialEntries = options?.initialEntries;

  return function TestQueryWrapper({ children }: { children: ReactNode }) {
    const content = withRouter ? (
      <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
    ) : (
      children
    );
    return <QueryClientProvider client={queryClient}>{content}</QueryClientProvider>;
  };
}

export function renderWithProviders(
  ui: ReactElement,
  options?: {
    queryClient?: QueryClient;
    withRouter?: boolean;
    initialEntries?: string[];
    routePath?: string;
  },
) {
  const queryClient = options?.queryClient ?? createTestQueryClient();
  const withRouter = options?.withRouter ?? true;
  const initialEntries = options?.initialEntries;
  const routePath = options?.routePath;

  const routedUi =
    withRouter && routePath ? (
      <Routes>
        <Route path={routePath} element={ui} />
      </Routes>
    ) : (
      ui
    );

  const tree = withRouter ? (
    <MemoryRouter initialEntries={initialEntries}>{routedUi}</MemoryRouter>
  ) : (
    routedUi
  );

  return {
    queryClient,
    ...render(<QueryClientProvider client={queryClient}>{tree}</QueryClientProvider>),
  };
}
