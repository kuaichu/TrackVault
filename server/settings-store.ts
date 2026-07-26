import fs from "node:fs/promises";
import path from "node:path";
import { getDatabase, isSqliteAvailable, readJsonStore, updateJsonStore } from "./database.js";
import { getClientSessionId } from "./request-context.js";
import type { AdminConfig, AdminConfigUpdate, AdminConfigView, AppSettings, AppSettingsUpdate, PublicAppSettings } from "./types.js";
import { clearStoredAccountSession } from "./account-session-snapshot.js";

const dataDir = path.resolve(process.env.TRACKVAULT_DATA_DIR?.trim() || path.join(process.cwd(), "data"));
const legacySettingsPath = path.join(dataDir, "settings.json");

const defaultSettings: AppSettings = {
  accountName: "本地账号",
  vipEnabled: false,
  providerMode: "netease",
  downloadDirectory: "downloads",
  neteaseCookie: "",
  qqMusicCookie: "",
  notes: "",
  defaultPlaybackQuality: "standard",
  defaultDownloadQuality: "hires",
  maxConcurrentDownloads: 3,
  startupView: "discover",
  autoLoadDiscoverOnStart: true
};

const defaultAdminConfig: AdminConfig = {
  trustedUserWhitelist: [],
  systemDefaultToken: "",
  systemFallbackEnabled: false
};

let initialized = false;

function normalizeSettings(input: Partial<AppSettings>): AppSettings {
  return {
    accountName: input.accountName?.trim() || defaultSettings.accountName,
    vipEnabled: Boolean(input.vipEnabled),
    providerMode:
      input.providerMode === "demo" || input.providerMode === "qq" || input.providerMode === "aggregate"
        ? input.providerMode
        : "netease",
    downloadDirectory: input.downloadDirectory?.trim() || defaultSettings.downloadDirectory,
    neteaseCookie: input.neteaseCookie?.trim() || "",
    qqMusicCookie: input.qqMusicCookie?.trim() || "",
    notes: input.notes?.trim() || "",
    defaultPlaybackQuality: normalizeDefaultQuality(input.defaultPlaybackQuality, defaultSettings.defaultPlaybackQuality),
    defaultDownloadQuality: normalizeDefaultQuality(input.defaultDownloadQuality),
    maxConcurrentDownloads: clampConcurrentDownloads(input.maxConcurrentDownloads),
    startupView: normalizeStartupView(input.startupView),
    autoLoadDiscoverOnStart: input.autoLoadDiscoverOnStart ?? defaultSettings.autoLoadDiscoverOnStart
  };
}

export class SettingsUpdateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsUpdateConflictError";
  }
}

export function toPublicSettings(settings: AppSettings): PublicAppSettings {
  const { neteaseCookie, qqMusicCookie, ...publicSettings } = settings;
  return {
    ...publicSettings,
    hasNeteaseCookie: Boolean(neteaseCookie.trim()),
    hasQqMusicCookie: Boolean(qqMusicCookie?.trim())
  };
}

export function mergeSettingsUpdate(current: AppSettings, update: AppSettingsUpdate): AppSettings {
  const nextInput: Partial<AppSettings> = { ...current };
  const ordinaryKeys: Array<keyof Omit<AppSettings, "neteaseCookie" | "qqMusicCookie">> = [
    "accountName",
    "vipEnabled",
    "providerMode",
    "downloadDirectory",
    "notes",
    "defaultPlaybackQuality",
    "defaultDownloadQuality",
    "maxConcurrentDownloads",
    "startupView",
    "autoLoadDiscoverOnStart"
  ];

  for (const key of ordinaryKeys) {
    const value = update[key];
    if (value !== undefined) {
      (nextInput as Record<string, unknown>)[key] = value;
    }
  }

  nextInput.neteaseCookie = mergeCredential(
    current.neteaseCookie,
    update.neteaseCookie,
    update.clearNeteaseCookie,
    "网易云"
  );
  nextInput.qqMusicCookie = mergeCredential(
    current.qqMusicCookie ?? "",
    update.qqMusicCookie,
    update.clearQqMusicCookie,
    "QQ 音乐"
  );

  return normalizeSettings(nextInput);
}

function mergeCredential(current: string, replacement: string | undefined, clear: boolean | undefined, platform: string) {
  const trimmedReplacement = replacement?.trim() ?? "";
  if (clear && trimmedReplacement) {
    throw new SettingsUpdateConflictError(`${platform} Cookie 不能同时设置和清除。`);
  }
  if (clear) {
    return "";
  }
  return trimmedReplacement || current;
}

function getSettingsKey() {
  return `session:${getClientSessionId()}`;
}

function getAdminConfigKey() {
  return "global:admin-config";
}

async function loadSeedSettings() {
  try {
    const raw = await fs.readFile(legacySettingsPath, "utf8");
    const source = normalizeSettings(JSON.parse(raw) as Partial<AppSettings>);
    return {
      ...source,
      neteaseCookie: "",
      qqMusicCookie: ""
    } satisfies AppSettings;
  } catch {
    return defaultSettings;
  }
}

async function initializeSettingsStore() {
  if (initialized) {
    return;
  }

  initialized = true;
}

export async function getSettings(): Promise<AppSettings> {
  await initializeSettingsStore();
  const settingsKey = getSettingsKey();

  if (!isSqliteAvailable()) {
    const row = readJsonStore().app_settings?.[settingsKey] as Partial<AppSettings> | undefined;
    if (row) {
      return normalizeSettings(row);
    }

    const seedSettings = await loadSeedSettings();
    updateJsonStore((store) => {
      store.app_settings ??= {};
      store.app_settings[settingsKey] = seedSettings;
    });
    return seedSettings;
  }

  const database = getDatabase();
  const selectStatement = database.prepare(`
    SELECT settings_json
    FROM app_settings
    WHERE settings_key = ?
  `);
  let row = selectStatement.get(settingsKey) as { settings_json: string } | undefined;

  if (!row) {
    const seedSettings = await loadSeedSettings();
    const insertStatement = database.prepare(`
      INSERT INTO app_settings (settings_key, settings_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(settings_key) DO NOTHING
    `);
    insertStatement.run(settingsKey, JSON.stringify(seedSettings), Date.now());
    row = (selectStatement.get(settingsKey) as { settings_json: string } | undefined) ?? { settings_json: JSON.stringify(seedSettings) };
  }

  return normalizeSettings(JSON.parse(row.settings_json) as Partial<AppSettings>);
}

export async function saveSettings(input: AppSettingsUpdate): Promise<AppSettings> {
  await initializeSettingsStore();
  const settingsKey = getSettingsKey();
  const currentSettings = await getSettingsByKey(settingsKey);
  const nextSettings = mergeSettingsUpdate(currentSettings, input);

  if (currentSettings.neteaseCookie !== nextSettings.neteaseCookie) {
    await clearStoredAccountSession();
  }

  if (!isSqliteAvailable()) {
    updateJsonStore((store) => {
      store.app_settings ??= {};
      store.app_settings[settingsKey] = nextSettings;
    });
    return nextSettings;
  }

  const database = getDatabase();
  const upsertStatement = database.prepare(`
    INSERT INTO app_settings (settings_key, settings_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(settings_key) DO UPDATE SET
      settings_json = excluded.settings_json,
      updated_at = excluded.updated_at
  `);

  upsertStatement.run(settingsKey, JSON.stringify(nextSettings), Date.now());
  return nextSettings;
}

export async function clearNeteaseCookie(): Promise<AppSettings> {
  return saveSettings({ clearNeteaseCookie: true });
}

export async function clearQqMusicCookie(): Promise<AppSettings> {
  return saveSettings({ clearQqMusicCookie: true });
}

export async function getSettingsForClientSessionId(clientSessionId: string): Promise<AppSettings> {
  return getSettingsByKey(`session:${sanitizeSettingsKey(clientSessionId)}`);
}

export async function getAdminConfig(): Promise<AdminConfigView> {
  const stored = await getStoredAdminConfig();
  return toAdminConfigView(stored);
}

export async function saveAdminConfig(input: AdminConfigUpdate): Promise<AdminConfigView> {
  await initializeSettingsStore();
  const current = await getStoredAdminConfig();
  const nextStored = normalizeAdminConfig({
    trustedUserWhitelist: parseWhitelistText(input.trustedUserWhitelistText),
    systemDefaultToken: input.systemDefaultToken?.trim() ? input.systemDefaultToken.trim() : current.systemDefaultToken,
    systemFallbackEnabled: Boolean(input.systemFallbackEnabled)
  });

  const adminConfigKey = getAdminConfigKey();

  if (!isSqliteAvailable()) {
    updateJsonStore((store) => {
      store.app_settings ??= {};
      store.app_settings[adminConfigKey] = nextStored;
    });
    return toAdminConfigView(nextStored);
  }

  const database = getDatabase();
  const upsertStatement = database.prepare(`
    INSERT INTO app_settings (settings_key, settings_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(settings_key) DO UPDATE SET
      settings_json = excluded.settings_json,
      updated_at = excluded.updated_at
  `);

  upsertStatement.run(adminConfigKey, JSON.stringify(nextStored), Date.now());
  return toAdminConfigView(nextStored);
}

export async function getStoredAdminConfig(): Promise<AdminConfig> {
  await initializeSettingsStore();
  const adminConfigKey = getAdminConfigKey();

  if (!isSqliteAvailable()) {
    const row = readJsonStore().app_settings?.[adminConfigKey] as Partial<AdminConfig> | undefined;
    if (!row) {
      updateJsonStore((store) => {
        store.app_settings ??= {};
        store.app_settings[adminConfigKey] = defaultAdminConfig;
      });
      return defaultAdminConfig;
    }

    return normalizeAdminConfig(row);
  }

  const database = getDatabase();
  const selectStatement = database.prepare(`
    SELECT settings_json
    FROM app_settings
    WHERE settings_key = ?
  `);
  let row = selectStatement.get(adminConfigKey) as { settings_json: string } | undefined;

  if (!row) {
    const insertStatement = database.prepare(`
      INSERT INTO app_settings (settings_key, settings_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(settings_key) DO NOTHING
    `);
    insertStatement.run(adminConfigKey, JSON.stringify(defaultAdminConfig), Date.now());
    row = (selectStatement.get(adminConfigKey) as { settings_json: string } | undefined) ?? { settings_json: JSON.stringify(defaultAdminConfig) };
  }

  return normalizeAdminConfig(JSON.parse(row.settings_json) as Partial<AdminConfig>);
}

async function getSettingsByKey(settingsKey: string): Promise<AppSettings> {
  await initializeSettingsStore();

  if (!isSqliteAvailable()) {
    const row = readJsonStore().app_settings?.[settingsKey] as Partial<AppSettings> | undefined;
    if (row) {
      return normalizeSettings(row);
    }

    const seedSettings = await loadSeedSettings();
    updateJsonStore((store) => {
      store.app_settings ??= {};
      store.app_settings[settingsKey] = seedSettings;
    });
    return seedSettings;
  }

  const database = getDatabase();
  const selectStatement = database.prepare(`
    SELECT settings_json
    FROM app_settings
    WHERE settings_key = ?
  `);
  let row = selectStatement.get(settingsKey) as { settings_json: string } | undefined;

  if (!row) {
    const seedSettings = await loadSeedSettings();
    const insertStatement = database.prepare(`
      INSERT INTO app_settings (settings_key, settings_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(settings_key) DO NOTHING
    `);
    insertStatement.run(settingsKey, JSON.stringify(seedSettings), Date.now());
    row = (selectStatement.get(settingsKey) as { settings_json: string } | undefined) ?? { settings_json: JSON.stringify(seedSettings) };
  }

  return normalizeSettings(JSON.parse(row.settings_json) as Partial<AppSettings>);
}

function normalizeDefaultQuality(
  level: AppSettings["defaultDownloadQuality"] | undefined,
  fallback = defaultSettings.defaultDownloadQuality
) {
  const allowed: AppSettings["defaultDownloadQuality"][] = ["hires", "lossless", "exhigh", "standard"];
  return level && allowed.includes(level) ? level : fallback;
}

function clampConcurrentDownloads(value: number | undefined) {
  const nextValue = Number(value);
  if (!Number.isFinite(nextValue)) {
    return defaultSettings.maxConcurrentDownloads;
  }

  return Math.min(5, Math.max(1, Math.round(nextValue)));
}

function normalizeStartupView(value: AppSettings["startupView"] | undefined) {
  const allowed: AppSettings["startupView"][] = ["discover", "search", "playlists", "downloads"];
  return value && allowed.includes(value) ? value : defaultSettings.startupView;
}

function normalizeAdminConfig(input: Partial<AdminConfig>): AdminConfig {
  const trustedUserWhitelist = Array.isArray(input.trustedUserWhitelist)
    ? [...new Set(input.trustedUserWhitelist.map((item) => item?.trim()).filter(Boolean))]
    : defaultAdminConfig.trustedUserWhitelist;
  const systemDefaultToken = input.systemDefaultToken?.trim() || "";

  return {
    trustedUserWhitelist,
    systemDefaultToken,
    systemFallbackEnabled: Boolean(input.systemFallbackEnabled) && Boolean(systemDefaultToken)
  };
}

function parseWhitelistText(input: string | undefined) {
  return (input ?? "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toAdminConfigView(config: AdminConfig): AdminConfigView {
  return {
    trustedUserWhitelistText: config.trustedUserWhitelist.join("\n"),
    hasSystemDefaultToken: Boolean(config.systemDefaultToken),
    systemFallbackEnabled: config.systemFallbackEnabled
  };
}

function sanitizeSettingsKey(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";
}
