import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  setProfile: vi.fn(),
  createClient: vi.fn(),
  requestTurnstileToken: vi.fn(),
}));

vi.mock("./config.js", () => ({
  getProfile: mocks.getProfile,
  getSupabaseConfig: vi.fn(() => ({
    url: "https://example.supabase.co",
    anonKey: "anon-key",
  })),
  removeProfile: vi.fn(),
  setProfile: mocks.setProfile,
}));

vi.mock("./supabase.js", () => ({
  createStaticStudioClient: mocks.createClient,
  isPersonalAccessToken: vi.fn(),
  resolveAccessTokenAuth: vi.fn(),
  resolveSessionTokenAuth: vi.fn(),
}));

vi.mock("./turnstile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./turnstile.js")>()),
  requestTurnstileToken: mocks.requestTurnstileToken,
}));

import { loginWithEmail, requestEmailLoginOtp } from "./auth.js";

describe("email login orchestration", () => {
  const session = {
    access_token: "access-token",
    refresh_token: "refresh-token",
    token_type: "bearer",
    user: { id: "user-1", email: "person@example.com" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProfile.mockResolvedValue({
      config: { supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "anon-key" },
      profileName: "default",
    });
  });

  it("verifies a supplied OTP without requesting another code or Turnstile token", async () => {
    const signInWithOtp = vi.fn();
    const verifyOtp = vi.fn().mockResolvedValue({
      data: { session },
      error: null,
    });
    mocks.createClient.mockReturnValue({
      auth: {
        signInWithOtp,
        verifyOtp,
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
            data: { currentLevel: "aal2" },
          }),
        },
      },
    });

    await expect(loginWithEmail({
      email: "person@example.com",
      otp: "123456",
    })).resolves.toMatchObject({ accessToken: "access-token" });

    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(mocks.requestTurnstileToken).not.toHaveBeenCalled();
    expect(verifyOtp).toHaveBeenCalledWith({
      email: "person@example.com",
      token: "123456",
      type: "email",
    });
    expect(mocks.setProfile).toHaveBeenCalledOnce();
  });

  it("uses a provided CAPTCHA token without starting the browser challenge", async () => {
    const signInWithOtp = vi.fn().mockResolvedValue({ error: null });
    mocks.createClient.mockReturnValue({ auth: { signInWithOtp } });

    await expect(requestEmailLoginOtp({
      email: "person@example.com",
      captchaToken: "provided-turnstile-token",
    })).resolves.toEqual({ email: "person@example.com" });

    expect(mocks.requestTurnstileToken).not.toHaveBeenCalled();
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "person@example.com",
      options: {
        shouldCreateUser: false,
        captchaToken: "provided-turnstile-token",
      },
    });
  });

  it("requests the signup-scoped Turnstile action when creating a user", async () => {
    const signInWithOtp = vi.fn().mockResolvedValue({ error: null });
    mocks.createClient.mockReturnValue({ auth: { signInWithOtp } });
    mocks.requestTurnstileToken.mockResolvedValue("browser-turnstile-token");

    await requestEmailLoginOtp({
      email: "new@example.com",
      createUser: true,
      openBrowser: false,
    });

    expect(mocks.requestTurnstileToken).toHaveBeenCalledWith({
      action: "studio_signup",
      openBrowser: false,
    });
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "new@example.com",
      options: {
        shouldCreateUser: true,
        captchaToken: "browser-turnstile-token",
      },
    });
  });
});
