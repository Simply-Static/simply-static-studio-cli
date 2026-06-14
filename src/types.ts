import type { SupabaseClient, User } from "@supabase/supabase-js";

export type OutputFormat = "text" | "json";

export interface CliOutputOptions {
  json?: boolean;
}

export interface StoredProfile {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  user?: {
    id: string;
    email?: string;
  };
}

export interface StoredConfig {
  activeProfile: string;
  profiles: Record<string, StoredProfile>;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

export interface AuthContext {
  supabase: SupabaseClient;
  profile?: StoredProfile;
  user: User;
  saveProfile?: (profile: StoredProfile) => Promise<void>;
}

export interface SiteRecord {
  id: string | number;
  url?: string;
  name?: string;
  status?: string;
  notes?: string | null;
  pull_zone_id?: string | number | null;
  storage_zone_id?: string | number | null;
  static_site_record_id?: string | number | null;
  site_id?: string | number | null;
  bedrock?: boolean | null;
  [key: string]: unknown;
}

export interface SiteMetaRecord {
  id?: string | number;
  site_id?: string | number;
  email?: string;
  username?: string;
  password?: string;
  basic_auth_user?: string;
  basic_auth_password?: string;
  admin_url?: string;
  secret_key?: string;
  [key: string]: unknown;
}

export interface CommandGlobals {
  json?: boolean;
  profile?: string;
}
