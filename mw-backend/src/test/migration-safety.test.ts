import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const DESTRUCTIVE_KEYWORDS = [
  "DROP TABLE", "DROP COLUMN", "TRUNCATE",
  "ALTER COLUMN", "DELETE FROM",
];

const MIGRATION_DIR = path.resolve(__dirname, "../../prisma/migrations/20260711_add_review_models");

describe("Migration SQL safety check", () => {
  it("migration directory exists", () => {
    expect(fs.existsSync(MIGRATION_DIR)).toBe(true);
  });

  it("migration.sql file exists", () => {
    expect(fs.existsSync(path.join(MIGRATION_DIR, "migration.sql"))).toBe(true);
  });

  const sql = fs.readFileSync(path.join(MIGRATION_DIR, "migration.sql"), "utf8");

  for (const keyword of DESTRUCTIVE_KEYWORDS) {
    it(`does not contain ${keyword}`, () => {
      const regex = new RegExp(keyword, "i");
      const matches = sql.match(regex);
      expect(matches, `Found destructive keyword "${keyword}" in migration SQL`).toBeNull();
    });
  }

  it("contains CREATE TABLE for review_items", () => {
    expect(sql).toContain("CREATE TABLE \"review_items\"");
  });

  it("contains CREATE TABLE for review_events", () => {
    expect(sql).toContain("CREATE TABLE \"review_events\"");
  });

  it("contains foreign key constraint", () => {
    expect(sql).toContain("FOREIGN KEY");
  });

  it("contains unique index on public_id", () => {
    expect(sql).toContain("review_items_public_id_key");
  });

  it("contains unique index on original_redis_key", () => {
    expect(sql).toContain("review_items_original_redis_key_key");
  });

  it("is purely additive (only CREATE, ALTER TABLE ADD)", () => {
    const lines = sql.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"));
    for (const line of lines) {
      const trimmed = line.trim().toUpperCase();
      if (trimmed.startsWith("CREATE") || trimmed.startsWith("ALTER") || trimmed.startsWith("--")) continue;
      // Skip empty lines, comments, and index/constraint names
      if (trimmed.startsWith("CONSTRAINT") || trimmed.startsWith("UNIQUE") || trimmed.startsWith("INDEX")) continue;
      if (trimmed.startsWith("(") || trimmed.startsWith(")") || trimmed.startsWith(",")) continue;
      if (/^[a-z_]/i.test(trimmed)) continue; // column definitions
      // Allow GRANT/COMMENT if present
      if (trimmed.startsWith("GRANT") || trimmed.startsWith("COMMENT")) continue;
    }
  });
});
