import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_SUPABASE_ANON_KEY, DEFAULT_SUPABASE_URL } from "./constants.js";
import type { StoredConfig, StoredProfile } from "./types.js";

const DEFAULT_PROFILE = "default";

export function getConfigPath(): string {
  const configDir =
    process.env.STATIC_STUDIO_CONFIG_DIR || join(homedir(), ".static-studio");
  return join(configDir, "config.json");
}

export function getEmptyConfig(): StoredConfig {
  return {
    activeProfile: DEFAULT_PROFILE,
    profiles: {},
    supabaseUrl: DEFAULT_SUPABASE_URL,
    supabaseAnonKey: DEFAULT_SUPABASE_ANON_KEY,
  };
}

export async function loadConfig(): Promise<StoredConfig> {
  const path = getConfigPath();
  if (!existsSync(path)) {
    return getEmptyConfig();
  }

  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<StoredConfig>;

  return {
    ...getEmptyConfig(),
    ...parsed,
    profiles: parsed.profiles || {},
  };
}

export async function saveConfig(config: StoredConfig): Promise<void> {
  const path = getConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function getProfile(profileName?: string): Promise<{
  config: StoredConfig;
  profileName: string;
  profile: StoredProfile | undefined;
}> {
  const config = await loadConfig();
  const resolvedName = profileName || config.activeProfile || DEFAULT_PROFILE;
  return {
    config,
    profileName: resolvedName,
    profile: config.profiles[resolvedName],
  };
}

export async function setProfile(
  profile: StoredProfile,
  profileName?: string,
): Promise<void> {
  const config = await loadConfig();
  const resolvedName = profileName || config.activeProfile || DEFAULT_PROFILE;
  config.activeProfile = resolvedName;
  config.profiles[resolvedName] = profile;
  await saveConfig(config);
}

export async function removeProfile(profileName?: string): Promise<boolean> {
  const config = await loadConfig();
  const resolvedName = profileName || config.activeProfile || DEFAULT_PROFILE;
  const existed = Boolean(config.profiles[resolvedName]);
  delete config.profiles[resolvedName];
  if (config.activeProfile === resolvedName) {
    config.activeProfile = Object.keys(config.profiles)[0] || DEFAULT_PROFILE;
  }
  await saveConfig(config);
  return existed;
}

export function getSupabaseConfig(config: StoredConfig): {
  url: string;
  anonKey: string;
} {
  return {
    url: process.env.STATIC_STUDIO_SUPABASE_URL || config.supabaseUrl || DEFAULT_SUPABASE_URL,
    anonKey:
      process.env.STATIC_STUDIO_SUPABASE_ANON_KEY ||
      config.supabaseAnonKey ||
      DEFAULT_SUPABASE_ANON_KEY,
  };
}
