type TableResult = {
  data?: unknown;
  error?: { message: string; code?: string } | null;
  count?: number | null;
};

type TableResolver = (table: string) => TableResult;
type TableInput = Record<string, TableResult> | TableResolver;

export interface QueryCall {
  table: string;
  method: string;
  args: unknown[];
}

export interface FunctionCall {
  name: string;
  body: unknown;
}

class QueryMock implements PromiseLike<TableResult> {
  constructor(
    private readonly table: string,
    private readonly result: TableResult,
    private readonly calls: QueryCall[],
  ) {}

  select(...args: unknown[]): this {
    this.calls.push({ table: this.table, method: "select", args });
    return this;
  }

  eq(...args: unknown[]): this {
    this.calls.push({ table: this.table, method: "eq", args });
    return this;
  }

  in(...args: unknown[]): this {
    this.calls.push({ table: this.table, method: "in", args });
    return this;
  }

  not(...args: unknown[]): this {
    this.calls.push({ table: this.table, method: "not", args });
    return this;
  }

  or(...args: unknown[]): this {
    this.calls.push({ table: this.table, method: "or", args });
    return this;
  }

  order(...args: unknown[]): this {
    this.calls.push({ table: this.table, method: "order", args });
    return this;
  }

  range(...args: unknown[]): Promise<TableResult> {
    this.calls.push({ table: this.table, method: "range", args });
    return Promise.resolve(this.result);
  }

  limit(...args: unknown[]): this {
    this.calls.push({ table: this.table, method: "limit", args });
    return this;
  }

  maybeSingle(): Promise<TableResult> {
    this.calls.push({ table: this.table, method: "maybeSingle", args: [] });
    return Promise.resolve(this.result);
  }

  single(): Promise<TableResult> {
    this.calls.push({ table: this.table, method: "single", args: [] });
    return Promise.resolve(this.result);
  }

  insert(...args: unknown[]): this {
    this.calls.push({ table: this.table, method: "insert", args });
    return this;
  }

  update(...args: unknown[]): this {
    this.calls.push({ table: this.table, method: "update", args });
    return this;
  }

  delete(...args: unknown[]): this {
    this.calls.push({ table: this.table, method: "delete", args });
    return this;
  }

  then<TResult1 = TableResult, TResult2 = never>(
    onfulfilled?: ((value: TableResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

export function createSupabaseMock(
  tables: TableInput,
  functionResult: unknown = { ok: true },
): {
  supabase: any;
  calls: QueryCall[];
  functionCalls: FunctionCall[];
} {
  const calls: QueryCall[] = [];
  const functionCalls: FunctionCall[] = [];
  const resolveTable = (table: string): TableResult => {
    if (typeof tables === "function") return tables(table);
    return tables[table] || { data: null, error: null };
  };

  return {
    calls,
    functionCalls,
    supabase: {
      from(table: string) {
        return new QueryMock(table, resolveTable(table), calls);
      },
      functions: {
        async invoke(name: string, options: { body?: unknown } = {}) {
          functionCalls.push({ name, body: options.body ?? {} });
          return { data: functionResult, error: null };
        },
      },
    },
  };
}
