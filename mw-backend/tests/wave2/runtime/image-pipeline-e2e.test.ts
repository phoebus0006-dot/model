// Image Pipeline End-to-End Test Suite.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { imageRoutes } from "../../../src/routes/images.js";
import { registerBigIntSerializer } from "../../../src/plugins/bigintSerializer.js";

const TEST_ASSETS_DIR = path.join(process.cwd(), "tmp_test_assets");
const VALID_JAN_CODE = "4580416940001";
const VALID_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("Image Pipeline End-to-End Test Suite", () => {
  let app: FastifyInstance;
  let mockImages: any[];

  before(async () => {
    process.env.ASSETS_PATH = TEST_ASSETS_DIR;

    const janDir = path.join(TEST_ASSETS_DIR, "figures", VALID_JAN_CODE);
    if (!fs.existsSync(janDir)) {
      fs.mkdirSync(janDir, { recursive: true });
    }

    const realImgPath = path.join(janDir, `${VALID_SHA256}_original.webp`);
    const jpegBuffer = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60,
      0x00, 0x60, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
      0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
      0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
      0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
      0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
      0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
      0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
      0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
      0x00, 0xbf, 0x00, 0xff, 0xd9
    ]);
    fs.writeFileSync(realImgPath, jpegBuffer);

    mockImages = [
      {
        id: 101n,
        figureId: 10n,
        janCode: VALID_JAN_CODE,
        sha256: VALID_SHA256,
        size: "original",
        format: "webp",
        fileSize: jpegBuffer.length,
        url: "original.webp",
        rawUrl: "https://static.mfc.net/upload/items/0/101.jpg",
      }
    ];

    const prismaMock = {
      figureImage: {
        async findUnique({ where }: any) {
          if (!where) return null;
          return mockImages.find(img => img.id === BigInt(where.id)) || null;
        }
      }
    };

    app = Fastify({ logger: false });
    app.decorate("prisma", prismaMock);
    registerBigIntSerializer(app);
    app.register(imageRoutes, { prefix: "/api/v1/figures/images" });
    await app.ready();
  });

  after(() => {
    if (fs.existsSync(TEST_ASSETS_DIR)) {
      fs.rmSync(TEST_ASSETS_DIR, { recursive: true, force: true });
    }
  });

  test("1. GET /api/v1/figures/images/101 returns 200 OK and correct Content-Type", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/figures/images/101"
    });

    assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    assert.equal(res.headers["content-type"], "image/webp");
    assert.ok(res.rawPayload.length > 0);
  });

  test("2. GET /api/v1/figures/images/999 (Non-existent ID) returns 404 Not Found", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/figures/images/999"
    });

    assert.equal(res.statusCode, 404);
  });
});
