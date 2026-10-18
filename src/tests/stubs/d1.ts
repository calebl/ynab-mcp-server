import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const MIGRATIONS = fileURLToPath(new URL("../../../migrations/", import.meta.url));

type Param = string | number | null;

/**
 * An in-memory stand-in for a Cloudflare D1 binding, backed by Node's SQLite
 * with the real migrations applied, so the service's SQL runs for real.
 * Covers the part of the D1 API the service uses.
 */
export function createTestD1(): D1Database & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(`${MIGRATIONS}${file}`, "utf8"));
  }

  /**
   * D1 binds `?NNN` parameters by number. Node's SQLite treats them as named,
   * so rewrite each to a plain `?` with the matching value in its place.
   */
  function positional(sql: string, params: Param[]): [string, Param[]] {
    const values: Param[] = [];
    const rewritten = sql.replace(/\?(\d+)/g, (_match, index: string) => {
      values.push(params[Number(index) - 1]);
      return "?";
    });
    return /\?\d/.test(sql) ? [rewritten, values] : [sql, params];
  }

  class Statement {
    constructor(readonly sql: string, readonly params: Param[] = []) {}

    private prepared(): [ReturnType<DatabaseSync["prepare"]>, Param[]] {
      const [sql, params] = positional(this.sql, this.params);
      return [sqlite.prepare(sql), params];
    }

    bind(...params: Param[]) {
      for (const param of params) {
        if (param === undefined) throw new Error("D1_TYPE_ERROR: undefined is not a supported bind value");
      }
      return new Statement(this.sql, params);
    }

    async first<T>(column?: string): Promise<T | null> {
      const [statement, params] = this.prepared();
      const row = statement.get(...params) as Record<string, unknown> | undefined;
      if (!row) return null;
      return (column ? row[column] : { ...row }) as T;
    }

    async all<T>() {
      const [statement, params] = this.prepared();
      const rows = statement.all(...params) as Record<string, unknown>[];
      return { results: rows.map((row) => ({ ...row })) as T[], success: true, meta: {} };
    }

    runSync() {
      const [statement, params] = this.prepared();
      const info = statement.run(...params);
      return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    }

    async run() {
      return this.runSync();
    }
  }

  const d1 = {
    sqlite,
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.runSync());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return d1 as unknown as D1Database & { sqlite: DatabaseSync };
}
