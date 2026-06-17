import { createClient, type Session, type SupabaseClient, type User } from "@supabase/supabase-js";
import { CliError, resolveFunctionError } from "./errors.js";
import { getProfile, getSupabaseConfig, setProfile } from "./config.js";
import type { AuthContext, StoredProfile } from "./types.js";

const PERSONAL_ACCESS_TOKEN_PREFIX = "ss_pat_";

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

type SupabaseConfig = {
  url: string;
  anonKey: string;
};

type AccessTokenExchangeSession = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  expires_at?: number;
  user: User;
};

export function isPersonalAccessToken(token: string): boolean {
  return token.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX);
}

async function exchangePersonalAccessToken(
  supabaseConfig: SupabaseConfig,
  token: string,
): Promise<{ session: AccessTokenExchangeSession; user: User }> {
  const exchangeClient = createStaticStudioClient(supabaseConfig);
  const { data, error } = await exchangeClient.functions.invoke<{
    session?: AccessTokenExchangeSession;
    user?: User;
    error?: string;
  }>("access-token", {
    body: { action: "exchange", token },
  });

  if (error) {
    throw await resolveFunctionError(error);
  }

  if (data?.error) {
    throw new Error(data.error);
  }

  if (!data?.session?.access_token || !data.session.user) {
    throw new Error("Access token exchange did not return a session.");
  }

  return {
    session: data.session,
    user: data.session.user,
  };
}

export async function resolveAccessTokenAuth(
  supabaseConfig: SupabaseConfig,
  token: string,
): Promise<{ supabase: SupabaseClient; user: User; session?: AccessTokenExchangeSession }> {
  let exchangeError: Error | null = null;

  try {
    const { session, user } = await exchangePersonalAccessToken(supabaseConfig, token);
    return {
      supabase: createStaticStudioClient({
        ...supabaseConfig,
        accessToken: session.access_token,
      }),
      user,
      session,
    };
  } catch (error) {
    exchangeError = error instanceof Error ? error : new Error(String(error));
    if (isPersonalAccessToken(token)) {
      throw new CliError(exchangeError.message);
    }
  }

  const supabase = createStaticStudioClient({
    ...supabaseConfig,
    accessToken: token,
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    const suffix = exchangeError ? ` Access token exchange failed: ${exchangeError.message}` : "";
    throw new CliError(`Token validation failed: ${error?.message || "unknown error"}.${suffix}`);
  }

  return {
    supabase,
    user: data.user,
  };
}

export async function resolveSessionTokenAuth(
  supabaseConfig: SupabaseConfig,
  accessToken: string,
  refreshToken: string,
): Promise<{ supabase: SupabaseClient; user: User; session: Session }> {
  const supabase = createStaticStudioClient(supabaseConfig);
  const { data, error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  if (error) {
    throw new CliError(`Session token pair is invalid: ${error.message}`);
  }

  if (!data.session) {
    throw new CliError("Session token pair could not be restored.");
  }

  return {
    supabase,
    user: data.session.user,
    session: data.session,
  };
}

export async function getAuthContext(profileName?: string): Promise<AuthContext> {
  const envToken = process.env.STATIC_STUDIO_ACCESS_TOKEN;
  const envRefreshToken = process.env.STATIC_STUDIO_REFRESH_TOKEN;
  const { config, profile, profileName: resolvedProfileName } = await getProfile(profileName);
  const supabaseConfig = getSupabaseConfig(config);

  if (envToken) {
    if (envRefreshToken) {
      if (isPersonalAccessToken(envToken)) {
        throw new CliError("STATIC_STUDIO_REFRESH_TOKEN is only for Supabase session access tokens. Unset it when using a Personal Access Token.");
      }

      const { supabase, session } = await resolveSessionTokenAuth(supabaseConfig, envToken, envRefreshToken);
      return {
        supabase,
        profile: {
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
          ...(session.expires_at ? { expiresAt: session.expires_at } : {}),
          ...(session.token_type ? { tokenType: session.token_type } : {}),
          user: userSummary(session.user),
        },
        user: session.user,
      };
    }

    const { supabase, user } = await resolveAccessTokenAuth(supabaseConfig, envToken);
    return {
      supabase,
      profile: {
        accessToken: envToken,
        user: userSummary(user),
      },
      user,
    };
  }

  if (!profile?.accessToken) {
    throw new CliError("Not logged in. Run `static-studio login` first or set STATIC_STUDIO_ACCESS_TOKEN.");
  }

  if (profile.refreshToken) {
    if (isPersonalAccessToken(profile.accessToken)) {
      throw new CliError("Saved profile combines a Personal Access Token with a refresh token. Run `static-studio login --token <token>` again without `--refresh-token`.");
    }

    let supabase: SupabaseClient;
    let session: Session;
    try {
      ({ supabase, session } = await resolveSessionTokenAuth(supabaseConfig, profile.accessToken, profile.refreshToken));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError(`${message}. Run \`static-studio login\` again.`);
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

  const { supabase: tokenClient, user } = await resolveAccessTokenAuth(supabaseConfig, profile.accessToken);

  return {
    supabase: tokenClient,
    profile,
    user,
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
