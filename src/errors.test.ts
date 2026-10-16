import { describe, expect, it } from "vitest";
import { FunctionsHttpError } from "@supabase/supabase-js";
import {
  CliError,
  cliErrorExitCode,
  cliErrorJson,
  cliErrorMessage,
  resolveFunctionError,
} from "./errors.js";

describe("CLI error formatting", () => {
  it("formats CliError details for JSON output", () => {
    const error = new CliError("Not logged in.", 2);

    expect(cliErrorMessage(error)).toBe("Not logged in.");
    expect(cliErrorExitCode(error)).toBe(2);
    expect(cliErrorJson(error)).toEqual({
      error: {
        message: "Not logged in.",
        name: "CliError",
        exitCode: 2,
      },
    });
  });

  it("falls back to exit code 1 for unknown errors", () => {
    expect(cliErrorMessage("boom")).toBe("boom");
    expect(cliErrorExitCode("boom")).toBe(1);
    expect(cliErrorJson("boom")).toEqual({
      error: {
        message: "boom",
        name: "Error",
        exitCode: 1,
      },
    });
  });

  it("includes resumable migration artifact metadata in JSON errors", () => {
    const error = new CliError("Upload completion is ambiguous.", 1, {
      artifactId: "11111111-1111-4111-8111-111111111111",
      deliveryAmbiguous: true,
    });

    expect(cliErrorJson(error)).toEqual({
      error: {
        message: "Upload completion is ambiguous.",
        name: "CliError",
        exitCode: 1,
        artifactId: "11111111-1111-4111-8111-111111111111",
      },
    });
  });

  it("preserves the domain preparation hint from an Edge Function response", async () => {
    const resolved = await resolveFunctionError(new FunctionsHttpError(
      new Response(JSON.stringify({
        error: "Failed to add hostname to BunnyCDN",
        details: "The domain example.com cannot be registered yet.",
        can_prepare_without_dns: true,
      }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    ));

    expect(resolved).toBeInstanceOf(CliError);
    expect(resolved.message).toBe("The domain example.com cannot be registered yet.");
    expect((resolved as CliError).status).toBe(409);
    expect((resolved as CliError).deliveryAmbiguous).toBe(false);
    expect((resolved as CliError).canPrepareWithoutDns).toBe(true);
  });
});
