/**
 * Fake em memória do query builder do supabase-js.
 *
 * Existe para que os testes exercitem a LÓGICA de verdade (validação de
 * cadeia de desempates, cálculo de estágio, qual id vai para qual RPC) em
 * vez de conferir texto-fonte. Cobre só o subconjunto que o projeto usa:
 * select/eq/in/is/order/maybeSingle, e `await` no próprio builder.
 *
 * Não substitui os testes de integração: as regras eleitorais continuam
 * verificadas contra o Postgres real, que é a fonte da verdade.
 */
export type TableRows = Record<string, Record<string, unknown>[]>;

type Filter = { column: string; test: (value: unknown) => boolean };

class FakeQuery implements PromiseLike<{ data: unknown; error: null }> {
  private readonly filters: Filter[] = [];

  constructor(private readonly rows: Record<string, unknown>[]) {}

  select() {
    return this;
  }

  order() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, test: (actual) => actual === value });
    return this;
  }

  is(column: string, value: unknown) {
    this.filters.push({ column, test: (actual) => (actual ?? null) === value });
    return this;
  }

  in(column: string, values: unknown[]) {
    this.filters.push({ column, test: (actual) => values.includes(actual) });
    return this;
  }

  private apply() {
    return this.rows.filter((row) => this.filters.every((f) => f.test(row[f.column])));
  }

  async maybeSingle() {
    return { data: this.apply()[0] ?? null, error: null };
  }

  then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.apply(), error: null as null }).then(onfulfilled, onrejected);
  }
}

export type RpcCall = { fn: string; args: Record<string, unknown> };

export function createFakeSupabase(
  tables: TableRows,
  rpcHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {},
) {
  const rpcCalls: RpcCall[] = [];
  const client = {
    from(table: string) {
      return new FakeQuery(tables[table] ?? []);
    },
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      rpcCalls.push({ fn, args });
      const handler = rpcHandlers[fn];
      if (!handler) return { data: null, error: null };
      return { data: handler(args), error: null };
    },
  };
  return { client, rpcCalls };
}
