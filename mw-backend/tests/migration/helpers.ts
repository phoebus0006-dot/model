/**
 * Shared database utilities for migration tests.
 * Parses DATABASE_URL for portable psql connection (works on Windows local and Linux CI).
 *
 * Each test file calls createDbHelpers(uniqueDbName) to get isolated database access.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://modelwiki:modelwiki_dev_pass_123@localhost:5432/modelwiki?schema=public";

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
  if (!DATABASE_URL) throw new Error("DATABASE_URL must be set to a disposable PostgreSQL instance");
  const conn = parseDbUrl(DATABASE_URL);
  const dbUrl = `postgresql://${conn.user}:${conn.password}@${conn.host}:${conn.port}/${dbName}`;
  const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: conn.password, DATABASE_URL: dbUrl };

  function psqlBase(args: string): string {
    return `psql -h ${conn.host} -p ${conn.port} -U ${conn.user} -d ${dbName} ${args}`.trim();
  }

  function setup(): void {
    try {
      execSync(`psql -h ${conn.host} -p ${conn.port} -U ${conn.user} -d postgres -c "DROP DATABASE IF EXISTS ${dbName};"`, {
        stdio: "pipe", timeout: 15000, env,
      });
      execSync(`psql -h ${conn.host} -p ${conn.port} -U ${conn.user} -d postgres -c "CREATE DATABASE ${dbName};"`, {
        stdio: "pipe", timeout: 15000, env,
      });
    } catch {
      // Disposable DB not running locally — tests handle graceful skip
    }
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