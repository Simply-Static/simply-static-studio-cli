import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { CliError, resolveFunctionError } from "./errors.js";
import { getProfile, getSupabaseConfig, setProfile } from "./config.js";
import type { AuthContext, StoredProfile } from "./types.js";

export function createStaticStudioClient(options: {
  url: string;
  anonKey: string;
  accessToken?: string;
}): SupabaseClient {
  const clientOptions: Parameters<typeof createClient>[2] = {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: "ss-studio-cli-auth",
    },
  };

  if (options.accessToken) {
    clientOptions.global = {
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
      },
    };
  }

  return createClient(options.url, options.anonKey, clientOptions);
}

function userSummary(user: { id: string; email?: string | null }): { id: string; email?: string } {
  return {
    id: user.id,
    ...(user.email ? { email: user.email } : {}),
  };
}

export async function getAuthContext(profileName?: string): Promise<AuthContext> {
  const envToken = process.env.STATIC_STUDIO_ACCESS_TOKEN;
  const envRefreshToken = process.env.STATIC_STUDIO_REFRESH_TOKEN;
  const { config, profile, profileName: resolvedProfileName } = await getProfile(profileName);
  const supabaseConfig = getSupabaseConfig(config);

  if (envToken) {
    const supabase = createStaticStudioClient({
      ...supabaseConfig,
      accessToken: envToken,
    });
    const { data, error } = await supabase.auth.getUser(envToken);
    if (error || !data.user) {
      throw new CliError(`Invalid STATIC_STUDIO_ACCESS_TOKEN: ${error?.message || "unknown error"}`);
    }
    return {
      supabase,
      profile: {
        accessToken: envToken,
        ...(envRefreshToken ? { refreshToken: envRefreshToken } : {}),
        user: userSummary(data.user),
      },
      user: data.user,
    };
  }

  if (!profile?.accessToken) {
    throw new CliError("Not logged in. Run `static-studio login` first or set STATIC_STUDIO_ACCESS_TOKEN.");
  }

  const supabase = createStaticStudioClient(supabaseConfig);

  if (profile.refreshToken) {
    const { data, error } = await supabase.auth.setSession({
      access_token: profile.accessToken,
      refresh_token: profile.refreshToken,
    });
    if (error) {
      throw new CliError(`Stored session is invalid: ${error.message}. Run \`static-studio login\` again.`);
    }

    const session = data.session;
    if (!session) {
      throw new CliError("Stored session could not be restored. Run `static-studio login` again.");
    }

    const nextProfile: StoredProfile = {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      ...(session.expires_at ? { expiresAt: session.expires_at } : {}),
      ...(session.token_type ? { tokenType: session.token_type } : {}),
      user: userSummary(session.user),
    };

    await setProfile(nextProfile, resolvedProfileName);

    return {
      supabase,
      profile: nextProfile,
      user: session.user,
      saveProfile: (next) => setProfile(next, resolvedProfileName),
    };
  }

  const tokenClient = createStaticStudioClient({
    ...supabaseConfig,
    accessToken: profile.accessToken,
  });
  const { data, error } = await tokenClient.auth.getUser(profile.accessToken);
  if (error || !data.user) {
    throw new CliError(`Stored token is invalid: ${error?.message || "unknown error"}. Run \`static-studio login\` again.`);
  }

  return {
    supabase: tokenClient,
    profile,
    user: data.user,
    saveProfile: (next) => setProfile(next, resolvedProfileName),
  };
}

export async function invokeFunction<T = unknown>(
  supabase: SupabaseClient,
  name: string,
  body?: unknown,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, {
    body: body ?? {},
  });

  if (error) {
    throw await resolveFunctionError(error);
  }

  if (data && typeof data === "object" && "error" in data && data.error) {
    throw new CliError(String((data as { error: unknown }).error));
  }

  return data as T;
}

export async function getCurrentUserId(profileName?: string): Promise<string> {
  const { user } = await getAuthContext(profileName);
  return user.id;
}
