/**
 * Shared database utilities for migration tests.
 * Parses DATABASE_URL for portable psql connection (works on Windows local and Linux CI).
 *
 * Each test file calls createDbHelpers(uniqueDbName) to get isolated database access.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL || "";

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
    execSync(`psql -h ${conn.host} -p ${conn.port} -U ${conn.user} -d postgres -c "DROP DATABASE IF EXISTS ${dbName};"`, {
      stdio: "pipe", timeout: 15000, env,
    });
    execSync(`psql -h ${conn.host} -p ${conn.port} -U ${conn.user} -d postgres -c "CREATE DATABASE ${dbName};"`, {
      stdio: "pipe", timeout: 15000, env,
    });
  }

  function runSql(sql: string): string {
    try {
      return execSync(psqlBase(`-t -A -F "\t"`), {
        encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"],
        input: sql, env,
      }).trim().replace(/\r/g, "");
    } catch (e: any) {
      return e.stdout ? e.stdout.trim().replace(/\r/g, "") : "";
    }
  }

  function runSqlRows(sql: string): string[][] {
    const r = runSql(sql);
    if (!r) return [];
    return r.split("\n").map(l => l.split("\t"));
  }

  function execSql(sql: string): boolean {
    try {
      execSync(psqlBase(`-v ON_ERROR_STOP=1`), {
        encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"],
        input: sql, env,
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function execPrisma(args: string): void {
    execSync(`npx prisma ${args}`, {
      cwd: process.cwd(), env, stdio: "pipe", timeout: 100000,
    });
  }

  function applyMigrationSql(migrationDir: string): void {
    const sqlPath = path.join(process.cwd(), "prisma", "migrations", migrationDir, "migration.sql");
    if (!fs.existsSync(sqlPath)) throw new Error(`Migration SQL not found: ${sqlPath}`);
    const sql = fs.readFileSync(sqlPath, "utf-8");
    if (!execSql(sql)) throw new Error(`Failed to apply migration SQL: ${migrationDir}`);
  }

  return { setup, runSql, runSqlRows, execSql, execPrisma, applyMigrationSql, dbUrl };
}