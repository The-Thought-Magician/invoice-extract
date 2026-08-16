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

export interface Database {
  query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  /**
   * Run a script containing several statements. Separate from `query` because
   * a parameterised statement can only ever be one command; PGlite rejects a
   * multi-statement string outright, and node-postgres would silently allow
   * SQL injection if it did not.
   */
  exec(sql: string): Promise<void>;
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
