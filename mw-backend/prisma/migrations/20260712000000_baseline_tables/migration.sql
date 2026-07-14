-- Baseline tables for ModelWiki.
-- This migration creates all core tables that existed before the review workflow.
-- Does NOT include review/crawler tables (those are in 20260713000000 and 20260713000001).
--
-- DRIFT POLICY: This migration is NOT idempotent. If any table/index/constraint
-- already exists, the migration fails loudly. This is intentional — silent drift
-- hiding is forbidden per the Wave 1 Schema Hardening contract.
--
-- EXISTING DATABASES: For databases that already have these tables (created by
-- a previous deployment path), do NOT run this migration directly. Instead use
-- the baseline flow documented in BASELINE_FLOW.md:
--   1. pg_dump backup
--   2. structural audit (prisma migrate diff)
--   3. prisma migrate resolve --applied 20260712000000_baseline_tables
--   4. verify _prisma_migrations
--   5. prisma migrate deploy (for subsequent migrations)

-- CreateTable: figures
CREATE TABLE "figures" (
    "id" BIGSERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_jp" TEXT,
    "name_en" TEXT,
    "description" TEXT,
    "scale" TEXT,
    "material" TEXT,
    "price_jpy" INTEGER,
    "release_date" TIMESTAMP(3),
    "height_mm" INTEGER,
    "weight_g" INTEGER,
    "jan_code" TEXT,
    "parent_id" BIGINT,
    "series_id" BIGINT,
    "manufacturer_id" BIGINT,
    "active_revision_id" BIGINT,
    "mfc_id" TEXT,
    "product_line" TEXT,
    "hobby_search_id" TEXT,
    "age_rating" TEXT,
    "amiami_id" TEXT,
    "hlj_id" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "figures_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "figures_slug_key" ON "figures"("slug");
CREATE UNIQUE INDEX "figures_jan_code_key" ON "figures"("jan_code");
CREATE UNIQUE INDEX "figures_active_revision_id_key" ON "figures"("active_revision_id");

-- CreateTable: figure_localized
CREATE TABLE "figure_localized" (
    "id" BIGSERIAL NOT NULL,
    "figure_id" BIGINT NOT NULL,
    "language" TEXT NOT NULL,
    "title" TEXT,
    "origin" TEXT,
    "character_name" TEXT,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "figure_localized_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "figure_localized_figure_id_language_key" ON "figure_localized"("figure_id", "language");

-- CreateTable: figure_releases
CREATE TABLE "figure_releases" (
    "id" BIGSERIAL NOT NULL,
    "figure_id" BIGINT NOT NULL,
    "edition" TEXT NOT NULL,
    "release_date" TIMESTAMP(3),
    "price_jpy" INTEGER,
    "is_rerelease" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "figure_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable: series
CREATE TABLE "series" (
    "id" BIGSERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_jp" TEXT,
    "name_en" TEXT,
    "media_type" TEXT,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "series_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "series_slug_key" ON "series"("slug");

-- CreateTable: characters
CREATE TABLE "characters" (
    "id" BIGSERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_jp" TEXT,
    "name_en" TEXT,
    "series_id" BIGINT,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "characters_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "characters_slug_key" ON "characters"("slug");

-- CreateTable: manufacturers
CREATE TABLE "manufacturers" (
    "id" BIGSERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_jp" TEXT,
    "name_en" TEXT,
    "country" TEXT,
    "website" TEXT,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "manufacturers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "manufacturers_slug_key" ON "manufacturers"("slug");

-- CreateTable: sculptors
CREATE TABLE "sculptors" (
    "id" BIGSERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_jp" TEXT,
    "name_en" TEXT,
    "alias" TEXT[],
    "style_tags" TEXT[],
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sculptors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sculptors_slug_key" ON "sculptors"("slug");

-- CreateTable: categories
CREATE TABLE "categories" (
    "id" BIGSERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" BIGINT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateTable: revisions
CREATE TABLE "revisions" (
    "id" BIGSERIAL NOT NULL,
    "figure_id" BIGINT NOT NULL,
    "content_md" TEXT NOT NULL,
    "summary_md" TEXT,
    "key_points" TEXT[],
    "related_keywords" TEXT[],
    "version_number" INTEGER NOT NULL,
    "edit_summary" TEXT,
    "editor_id" BIGINT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "prompt_version" TEXT,
    "quality_score" DECIMAL(65,30),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "revisions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "revisions_figure_id_version_number_key" ON "revisions"("figure_id", "version_number");

-- CreateTable: figure_images
CREATE TABLE "figure_images" (
    "id" BIGSERIAL NOT NULL,
    "figure_id" BIGINT NOT NULL,
    "url" TEXT,
    "jan_code" TEXT,
    "sha256" TEXT,
    "size" TEXT NOT NULL DEFAULT 'raw',
    "format" TEXT NOT NULL DEFAULT 'webp',
    "width" INTEGER,
    "height" INTEGER,
    "alt" TEXT,
    "blurhash" TEXT,
    "file_size" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT,
    "is_nsfw" BOOLEAN NOT NULL DEFAULT false,
    "data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "figure_images_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "figure_images_figure_id_sha256_size_key" ON "figure_images"("figure_id", "sha256", "size");

-- CreateTable: figure_category
CREATE TABLE "figure_category" (
    "figure_id" BIGINT NOT NULL,
    "category_id" BIGINT NOT NULL,
    CONSTRAINT "figure_category_pkey" PRIMARY KEY ("figure_id","category_id")
);

-- CreateTable: figure_sculptor
CREATE TABLE "figure_sculptor" (
    "figure_id" BIGINT NOT NULL,
    "sculptor_id" BIGINT NOT NULL,
    "role" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "figure_sculptor_pkey" PRIMARY KEY ("figure_id","sculptor_id")
);

-- CreateTable: figure_character
CREATE TABLE "figure_character" (
    "figure_id" BIGINT NOT NULL,
    "character_id" BIGINT NOT NULL,
    "is_featured" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "figure_character_pkey" PRIMARY KEY ("figure_id","character_id")
);

-- CreateTable: users (original schema — no email fields yet; added in 20260714000000)
CREATE TABLE "users" (
    "id" BIGSERIAL NOT NULL,
    "password_hash" TEXT,
    "display_name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "google_sub" TEXT,
    "wechat_openid" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_google_sub_key" ON "users"("google_sub");
CREATE UNIQUE INDEX "users_wechat_openid_key" ON "users"("wechat_openid");

-- CreateTable: favorite_groups
CREATE TABLE "favorite_groups" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "favorite_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable: favorites
CREATE TABLE "favorites" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "figure_id" BIGINT NOT NULL,
    "group_id" BIGINT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "favorites_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "favorites_user_id_figure_id_key" ON "favorites"("user_id", "figure_id");

-- CreateTable: figure_likes
CREATE TABLE "figure_likes" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "figure_id" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "figure_likes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "figure_likes_user_id_figure_id_key" ON "figure_likes"("user_id", "figure_id");

-- CreateTable: figure_comments
CREATE TABLE "figure_comments" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "figure_id" BIGINT NOT NULL,
    "body" TEXT NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "figure_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable: entity_mapping
CREATE TABLE "entity_mapping" (
    "id" BIGSERIAL NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" BIGINT NOT NULL,
    "source" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_name" TEXT,
    "confidence" DECIMAL(65,30),
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "entity_mapping_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "entity_mapping_entity_type_source_source_id_key" ON "entity_mapping"("entity_type", "source", "source_id");

-- CreateTable: redirect_map
CREATE TABLE "redirect_map" (
    "id" BIGSERIAL NOT NULL,
    "from_path" TEXT NOT NULL,
    "to_path" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL DEFAULT 301,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "redirect_map_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "redirect_map_from_path_key" ON "redirect_map"("from_path");

-- Foreign keys
ALTER TABLE "figures" ADD CONSTRAINT "figures_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "figures"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "figures" ADD CONSTRAINT "figures_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "series"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "figures" ADD CONSTRAINT "figures_manufacturer_id_fkey" FOREIGN KEY ("manufacturer_id") REFERENCES "manufacturers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "figures" ADD CONSTRAINT "figures_active_revision_id_fkey" FOREIGN KEY ("active_revision_id") REFERENCES "revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "figure_localized" ADD CONSTRAINT "figure_localized_figure_id_fkey" FOREIGN KEY ("figure_id") REFERENCES "figures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "figure_releases" ADD CONSTRAINT "figure_releases_figure_id_fkey" FOREIGN KEY ("figure_id") REFERENCES "figures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "characters" ADD CONSTRAINT "characters_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "series"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "revisions" ADD CONSTRAINT "revisions_figure_id_fkey" FOREIGN KEY ("figure_id") REFERENCES "figures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "figure_images" ADD CONSTRAINT "figure_images_figure_id_fkey" FOREIGN KEY ("figure_id") REFERENCES "figures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "figure_category" ADD CONSTRAINT "figure_category_figure_id_fkey" FOREIGN KEY ("figure_id") REFERENCES "figures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "figure_category" ADD CONSTRAINT "figure_category_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "figure_sculptor" ADD CONSTRAINT "figure_sculptor_figure_id_fkey" FOREIGN KEY ("figure_id") REFERENCES "figures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "figure_sculptor" ADD CONSTRAINT "figure_sculptor_sculptor_id_fkey" FOREIGN KEY ("sculptor_id") REFERENCES "sculptors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "figure_character" ADD CONSTRAINT "figure_character_figure_id_fkey" FOREIGN KEY ("figure_id") REFERENCES "figures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "figure_character" ADD CONSTRAINT "figure_character_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "favorite_groups" ADD CONSTRAINT "favorite_groups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_figure_id_fkey" FOREIGN KEY ("figure_id") REFERENCES "figures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "favorite_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "figure_likes" ADD CONSTRAINT "figure_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "figure_likes" ADD CONSTRAINT "figure_likes_figure_id_fkey" FOREIGN KEY ("figure_id") REFERENCES "figures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "figure_comments" ADD CONSTRAINT "figure_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "figure_comments" ADD CONSTRAINT "figure_comments_figure_id_fkey" FOREIGN KEY ("figure_id") REFERENCES "figures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
