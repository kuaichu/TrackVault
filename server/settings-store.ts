import fs from "node:fs/promises";
import path from "node:path";
import { getDatabase, isSqliteAvailable, readJsonStore, updateJsonStore } from "./database.js";
import { getClientSessionId } from "./request-context.js";
import type { AdminConfig, AdminConfigUpdate, AdminConfigView, AppSettings } from "./types.js";

const dataDir = path.resolve(process.cwd(), "data");
const legacySettingsPath = path.join(dataDir, "settings.json");

const defaultSettings: AppSettings = {
  accountName: "本地账号",
  vipEnabled: false,
  providerMode: "netease",
  downloadDirectory: "downloads",
  neteaseCookie: "",
  notes: "",
  defaultPlaybackQuality: "standard",
  defaultDownloadQuality: "hires",
  maxConcurrentDownloads: 3
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
    providerMode: input.providerMode === "demo" ? "demo" : "netease",
    downloadDirectory: input.downloadDirectory?.trim() || defaultSettings.downloadDirectory,
    neteaseCookie: input.neteaseCookie?.trim() || "",
    notes: input.notes?.trim() || "",
    defaultPlaybackQuality: normalizeDefaultQuality(input.defaultPlaybackQuality, defaultSettings.defaultPlaybackQuality),
    defaultDownloadQuality: normalizeDefaultQuality(input.defaultDownloadQuality),
    maxConcurrentDownloads: clampConcurrentDownloads(input.maxConcurrentDownloads)
  };
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
      neteaseCookie: ""
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
    `);
    insertStatement.run(settingsKey, JSON.stringify(seedSettings), Date.now());
    row = { settings_json: JSON.stringify(seedSettings) };
  }

  return normalizeSettings(JSON.parse(row.settings_json) as Partial<AppSettings>);
}

export async function saveSettings(input: AppSettings): Promise<AppSettings> {
  await initializeSettingsStore();
  const settingsKey = getSettingsKey();

  const nextSettings = normalizeSettings(input);

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
    `);
    insertStatement.run(adminConfigKey, JSON.stringify(defaultAdminConfig), Date.now());
    row = { settings_json: JSON.stringify(defaultAdminConfig) };
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
    `);
    insertStatement.run(settingsKey, JSON.stringify(seedSettings), Date.now());
    row = { settings_json: JSON.stringify(seedSettings) };
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
