import type { Session } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { getProfile, getSupabaseConfig, removeProfile, setProfile } from "./config.js";
import {
  createStaticStudioClient,
  isPersonalAccessToken,
  resolveAccessTokenAuth,
  resolveSessionTokenAuth,
} from "./supabase.js";
import { prompt } from "./prompt.js";
import type { StoredProfile } from "./types.js";

function userSummary(user: { id: string; email?: string | null }): { id: string; email?: string } {
  return {
    id: user.id,
    ...(user.email ? { email: user.email } : {}),
  };
}

export async function loginWithToken(options: {
  token: string;
  refreshToken?: string;
  profile?: string;
}): Promise<StoredProfile> {
  const { config, profileName } = await getProfile(options.profile);
  const supabaseConfig = getSupabaseConfig(config);
  if (options.refreshToken && isPersonalAccessToken(options.token)) {
    throw new CliError("Do not use --refresh-token with a Personal Access Token.");
  }

  if (options.refreshToken) {
    const { session } = await resolveSessionTokenAuth(supabaseConfig, options.token, options.refreshToken);
    const profile: StoredProfile = {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      ...(session.expires_at ? { expiresAt: session.expires_at } : {}),
      ...(session.token_type ? { tokenType: session.token_type } : {}),
      user: userSummary(session.user),
    };
    await setProfile(profile, profileName);
    return profile;
  }

  const { user } = await resolveAccessTokenAuth(supabaseConfig, options.token);

  const profile: StoredProfile = {
    accessToken: options.token,
    user: userSummary(user),
  };
  await setProfile(profile, profileName);
  return profile;
}

export async function loginWithEmail(options: {
  email?: string;
  otp?: string;
  createUser?: boolean;
  profile?: string;
}): Promise<StoredProfile> {
  const { config, profileName } = await getProfile(options.profile);
  const supabase = createStaticStudioClient(getSupabaseConfig(config));
  const email = options.email || (await prompt("Email: "));

  const { error: signInError } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: Boolean(options.createUser),
    },
  });

  if (signInError) {
    throw new CliError(signInError.message);
  }

  process.stderr.write("A 6-digit code was sent to your email.\n");
  const token = options.otp || (await prompt("Code: "));

  let session: Session | null = null;
  let lastError: Error | null = null;
  for (const type of ["email", "invite", "signup"] as const) {
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token: token.trim(),
      type,
    });

    if (!error && data.session) {
      session = data.session;
      lastError = null;
      break;
    }
    lastError = error || null;
  }

  if (!session) {
    throw new CliError(lastError?.message || "Invalid email verification code.");
  }

  const mfaSession = await maybeVerifyMfa(supabase, session);

  const profile: StoredProfile = {
    accessToken: mfaSession.access_token,
    refreshToken: mfaSession.refresh_token,
    ...(mfaSession.expires_at ? { expiresAt: mfaSession.expires_at } : {}),
    ...(mfaSession.token_type ? { tokenType: mfaSession.token_type } : {}),
    user: userSummary(mfaSession.user),
  };
  await setProfile(profile, profileName);
  return profile;
}

async function maybeVerifyMfa(
  supabase: ReturnType<typeof createStaticStudioClient>,
  session: Session,
): Promise<Session> {
  let requiresMfa = false;
  try {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const raw = data as typeof data & { current_level?: string };
    const level = String(raw?.currentLevel || raw?.current_level || "").toLowerCase();
    requiresMfa = level !== "aal2";
  } catch {
    requiresMfa = false;
  }

  if (!requiresMfa) {
    return session;
  }

  const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
  if (factorsError) {
    throw new CliError(`Could not list MFA factors: ${factorsError.message}`);
  }

  const factors = (factorsData?.all || factorsData?.totp || []) as Array<{
    id?: string;
    factor_type?: string;
    type?: string;
    status?: string;
  }>;
  const totp = factors.find((factor) => {
    const type = factor.factor_type || factor.type;
    return type === "totp" && (factor.status === "verified" || factor.status === "active");
  });

  if (!totp?.id) {
    return session;
  }

  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
    factorId: totp.id,
  });
  if (challengeError) {
    throw new CliError(`Could not start MFA challenge: ${challengeError.message}`);
  }

  const code = await prompt("MFA code: ");
  const { error: verifyError } = await supabase.auth.mfa.verify({
    factorId: totp.id,
    challengeId: challenge.id,
    code: code.trim(),
  });

  if (verifyError) {
    throw new CliError(`MFA verification failed: ${verifyError.message}`);
  }

  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    throw new CliError("MFA succeeded, but no session was returned.");
  }

  return data.session;
}

export async function logout(profile?: string): Promise<boolean> {
  return removeProfile(profile);
}
