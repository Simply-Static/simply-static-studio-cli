import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
} from "@supabase/supabase-js";

export class CliError extends Error {
  exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export function cliErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cliErrorExitCode(error: unknown): number {
  return error instanceof CliError ? error.exitCode : 1;
}

export function cliErrorJson(error: unknown): {
  error: {
    message: string;
    name: string;
    exitCode: number;
  };
} {
  return {
    error: {
      message: cliErrorMessage(error),
      name: error instanceof Error ? error.name : "Error",
      exitCode: cliErrorExitCode(error),
    },
  };
}

export async function resolveFunctionError(error: unknown): Promise<Error> {
  if (error instanceof FunctionsHttpError) {
    const context = error.context as Response;
    try {
      const payload = (await context.clone().json()) as {
        error?: unknown;
        message?: unknown;
        details?: unknown;
      };
      const message =
        payload?.error ||
        payload?.message ||
        payload?.details ||
        `${context.status} ${context.statusText}`;
      return new Error(String(message));
    } catch {
      try {
        const text = await context.clone().text();
        return new Error(text || `${context.status} ${context.statusText}`);
      } catch {
        return new Error(`${context.status} ${context.statusText}`);
      }
    }
  }

  if (error instanceof FunctionsRelayError || error instanceof FunctionsFetchError) {
    return new Error(error.message);
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

export function assertOk<T>(
  data: T,
  error: unknown,
  fallback = "Request failed",
): asserts data is T {
  if (error) {
    throw error instanceof Error ? error : new CliError(fallback);
  }
}
