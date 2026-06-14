import { describe, expect, it } from "vitest";
import { CliError, cliErrorExitCode, cliErrorJson, cliErrorMessage } from "./errors.js";

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
});
