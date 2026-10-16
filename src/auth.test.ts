import { describe, expect, it, vi } from "vitest";
import { requestEmailOtp, verifyEmailOtp } from "./auth.js";
import { CliError } from "./errors.js";

describe("email OTP requests", () => {
  it("sends the Turnstile token with the Supabase OTP request", async () => {
    const signInWithOtp = vi.fn().mockResolvedValue({ error: null });

    await requestEmailOtp({ auth: { signInWithOtp } } as any, {
      email: "person@example.com",
      createUser: true,
      captchaToken: "turnstile-token-123",
    });

    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "person@example.com",
      options: {
        shouldCreateUser: true,
        captchaToken: "turnstile-token-123",
      },
    });
  });

  it("surfaces an OTP request rejection without exposing the token", async () => {
    const signInWithOtp = vi.fn().mockResolvedValue({
      error: { message: "captcha verification failed" },
    });

    await expect(requestEmailOtp({ auth: { signInWithOtp } } as any, {
      email: "person@example.com",
      captchaToken: "turnstile-token-secret",
    })).rejects.toEqual(new CliError("captcha verification failed"));
  });

  it("verifies a previously requested code without sending another OTP", async () => {
    const session = {
      access_token: "access-token",
      refresh_token: "refresh-token",
      user: { id: "user-1", email: "person@example.com" },
    };
    const signInWithOtp = vi.fn();
    const verifyOtp = vi.fn().mockResolvedValue({
      data: { session },
      error: null,
    });

    await expect(verifyEmailOtp({
      auth: { signInWithOtp, verifyOtp },
    } as any, {
      email: "person@example.com",
      token: " 123456 ",
    })).resolves.toBe(session);

    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(verifyOtp).toHaveBeenCalledWith({
      email: "person@example.com",
      token: "123456",
      type: "email",
    });
  });

  it("rejects an empty verification code without contacting Supabase", async () => {
    const verifyOtp = vi.fn();

    await expect(verifyEmailOtp({ auth: { verifyOtp } } as any, {
      email: "person@example.com",
      token: "   ",
    })).rejects.toEqual(new CliError("Email verification code is required."));
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});
