/**
 * Database access.
 *
 * Two backends behind one interface. `DATABASE_URL` selects real Postgres.
 * Without it the app runs on PGlite, an embedded build of Postgres, so the
 * whole application including the end to end suite runs with no server to
 * install. The SQL is identical either way; PGlite is Postgres, not an
 * imitation of it.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface QueryResult<Row> {
  rows: Row[];
}

export interface Queryable {
  query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface Database extends Queryable {
  /**
   * Run a script containing several statements. Separate from `query` because
   * a parameterised statement can only ever be one command; PGlite rejects a
   * multi-statement string outright, and node-postgres would silently allow
   * SQL injection if it did not.
   */
  exec(sql: string): Promise<void>;
  /**
   * Run `body` inside a transaction, committing on return and rolling back on
   * throw.
   *
   * Writes here are multi-statement and must not half-apply. A review inserts
   * correction rows and then updates the invoice; without this, a rejected
   * update leaves the labelled set holding labels for a change that was never
   * made, and a retry duplicates them. Since the labelled set is the only route
   * to opening the auto-approve gate (ADR 0002), corrupting it is worse than
   * failing the write.
   */
  transaction<T>(body: (tx: Queryable) => Promise<T>): Promise<T>;
}

/**
 * Bracket the body in begin/commit/rollback on a client that is ours alone.
 *
 * The caller must guarantee exclusivity. Issuing these statements on a
 * connection someone else is also using interleaves two transactions on one
 * backend: one caller's `commit` commits the other's half-written rows, and a
 * constraint violation in either leaves the shared session aborted, so every
 * later query fails with 25P02 until something rolls back.
 */
async function runTransaction<T>(
  client: Queryable,
  body: (tx: Queryable) => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    const result = await body(client);
    await client.query("commit");
    return result;
  } catch (error) {
    // A failed rollback must not mask the error that caused it.
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

/**
 * Resolved from the working directory rather than from `import.meta.url`.
 * Next.js rewrites `new URL(..., import.meta.url)` during bundling, which turns
 * a path into a URL object and breaks `readFile` at build time.
 */
function schemaPath(): string {
  const candidates = [
    process.env.SCHEMA_PATH,
    join(process.cwd(), "db/schema.sql"),
    join(process.cwd(), "../../db/schema.sql"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  throw new Error(`db/schema.sql not found; looked in ${candidates.join(", ")}`);
}

let instance: Promise<Database> | null = null;

export function getDatabase(): Promise<Database> {
  instance ??= connect();
  return instance;
}

/** Test helper: drop the memoised connection so the next call reconnects. */
export function resetDatabase(): void {
  instance = null;
}

async function connect(): Promise<Database> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url });
    const database: Database = {
      query: async (sql, parameters = []) => pool.query(sql, [...parameters]) as never,
      exec: async (sql) => {
        await pool.query(sql);
      },
      // One client for the whole transaction. Running begin/commit through the
      // pool would let the statements land on different connections.
      transaction: async (body) => {
        const client = await pool.connect();
        try {
          return await runTransaction(
            { query: async (sql, parameters = []) => client.query(sql, [...parameters]) as never },
            body,
          );
        } finally {
          client.release();
        }
      },
    };
    await migrate(database);
    return database;
  }

  const { PGlite } = await import("@electric-sql/pglite");
  // A path keeps data across a dev-server restart; memory:// is used by tests.
  const pglite = new PGlite(process.env.PGLITE_PATH ?? "memory://invoice-extract");
  const database: Database = {
    query: async (sql, parameters = []) => pglite.query(sql, [...parameters]) as never,
    exec: async (sql) => {
      await pglite.exec(sql);
    },
    // PGlite's own transaction, not the begin/commit helper. There is exactly
    // one backend here, so two concurrent drains issuing their own begin/commit
    // would interleave on it. This serialises them; the helper cannot.
    transaction: (body) =>
      pglite.transaction(async (tx) =>
        body({ query: async (sql, parameters = []) => tx.query(sql, [...parameters]) as never }),
      ) as Promise<never>,
  };
  await migrate(database);
  return database;
}

/**
 * Apply the schema if it is not already there.
 *
 * Deliberately naive: this is a single-file schema and a young project. When
 * the schema starts changing under live data, replace this with a real
 * migration tool rather than growing conditionals here.
 */
async function migrate(database: Database): Promise<void> {
  const { rows } = await database.query<{ exists: boolean }>(
    "select exists (select 1 from information_schema.tables where table_name = 'invoice') as exists",
  );
  if (rows[0]?.exists) return;

  const schema = await readFile(schemaPath(), "utf8");
  await database.exec(schema);
}
