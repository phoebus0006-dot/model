/**
 * Shared database utilities for migration tests.
 * Parses DATABASE_URL for portable psql connection (works on Windows local and Linux CI).
 *
 * Each test file calls createDbHelpers(uniqueDbName) to get isolated database access.
 */
import { execSync } from "node:child_process";
import path from "node:path";

interface DbConn {
  user: string;
  password: string;
  host: string;
  port: string;
}

function parseDbUrl(url: string): DbConn {
  const m = url.match(/^postgresql:\/\/([^:]+):([^@]*)@([^:]+):(\d+)\/.+$/);
  if (!m) throw new Error(`Invalid DATABASE_URL format: ${url}`);
  return { user: m[1], password: m[2], host: m[3], port: m[4] };
}

export function createDbHelpers(dbName: string) {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set to a disposable PostgreSQL instance");
  }

  const DATABASE_URL = process.env.DATABASE_URL;
  const conn = parseDbUrl(DATABASE_URL);
  const dbUrl = `postgresql://${conn.user}:${conn.password}@${conn.host}:${conn.port}/${dbName}?schema=public`;
  const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: conn.password, DATABASE_URL: dbUrl };

  function psqlBase(args: string): string {
    return `psql -h ${conn.host} -p ${conn.port} -U ${conn.user} -d ${dbName} ${args}`.trim();
  }

  function setup(): void {
    // Database setup failure MUST throw error directly (no swallowing or graceful skip)
    execSync(`psql -h ${conn.host} -p ${conn.port} -U ${conn.user} -d postgres -c "DROP DATABASE IF EXISTS ${dbName};"`, {
      stdio: "pipe", timeout: 15000, env,
    });
    execSync(`psql -h ${conn.host} -p ${conn.port} -U ${conn.user} -d postgres -c "CREATE DATABASE ${dbName};"`, {
      stdio: "pipe", timeout: 15000, env,
    });
  }

  function teardown(): void {
    try {
      execSync(`psql -h ${conn.host} -p ${conn.port} -U ${conn.user} -d postgres -c "DROP DATABASE IF EXISTS ${dbName};"`, {
        stdio: "pipe", timeout: 15000, env,
      });
    } catch {}
  }

  return { setup, teardown, psqlBase, dbUrl, env };
}