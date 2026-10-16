import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
} from "@supabase/supabase-js";

export class CliError extends Error {
  exitCode: number;
  status?: number;
  code?: string;
  deliveryAmbiguous?: boolean;
  canPrepareWithoutDns?: boolean;
  artifactId?: string;

  constructor(
    message: string,
    exitCode = 1,
    metadata: {
      status?: number;
      code?: string;
      deliveryAmbiguous?: boolean;
      canPrepareWithoutDns?: boolean;
      artifactId?: string;
    } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    if (metadata.status !== undefined) this.status = metadata.status;
    if (metadata.code !== undefined) this.code = metadata.code;
    if (metadata.deliveryAmbiguous !== undefined) {
      this.deliveryAmbiguous = metadata.deliveryAmbiguous;
    }
    if (metadata.canPrepareWithoutDns !== undefined) {
      this.canPrepareWithoutDns = metadata.canPrepareWithoutDns;
    }
    if (metadata.artifactId !== undefined) this.artifactId = metadata.artifactId;
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
    artifactId?: string;
  };
} {
  return {
    error: {
      message: cliErrorMessage(error),
      name: error instanceof Error ? error.name : "Error",
      exitCode: cliErrorExitCode(error),
      ...(error instanceof CliError && error.artifactId
        ? { artifactId: error.artifactId }
        : {}),
    },
  };
}

export async function resolveFunctionError(error: unknown): Promise<Error> {
  if (error instanceof FunctionsHttpError) {
    const context = error.context as Response;
    try {
      const payload = (await context.clone().json()) as {
        code?: unknown;
        error?: unknown;
        message?: unknown;
        details?: unknown;
        can_prepare_without_dns?: unknown;
      };
      const message =
        payload?.details ||
        payload?.message ||
        payload?.error ||
        `${context.status} ${context.statusText}`;
      return new CliError(String(message), 1, {
        status: context.status,
        ...(typeof payload?.code === "string" ? { code: payload.code } : {}),
        deliveryAmbiguous: context.status >= 500,
        ...(payload?.can_prepare_without_dns === true
          ? { canPrepareWithoutDns: true }
          : {}),
      });
    } catch {
      try {
        const text = await context.clone().text();
        return new CliError(
          text || `${context.status} ${context.statusText}`,
          1,
          {
            status: context.status,
            deliveryAmbiguous: context.status >= 500,
          },
        );
      } catch {
        return new CliError(`${context.status} ${context.statusText}`, 1, {
          status: context.status,
          deliveryAmbiguous: context.status >= 500,
        });
      }
    }
  }

  if (error instanceof FunctionsRelayError || error instanceof FunctionsFetchError) {
    return new CliError(error.message, 1, { deliveryAmbiguous: true });
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
