import type { PrismaClient } from "@prisma/client";

export interface UpsertFigureImageInput {
  figureId: bigint;
  janCode?: string | null;
  sha256?: string | null;
  size: string;
  format: string;
  width?: number | null;
  height?: number | null;
  fileSize?: number | null;
  alt?: string | null;
  sortOrder: number;
  source?: string | null;
  isNsfw: boolean;
  data?: any;
}

export async function upsertFigureImageRecord(
  prisma: PrismaClient, input: UpsertFigureImageInput
): Promise<{ image: any; created: boolean }> {
  const source = input.source ? String(input.source) : null;
  const sha256 = input.sha256 ? String(input.sha256) : null;
  const size = String(input.size || "raw");
  const whereBase = { figureId: input.figureId, size } as const;

  let existing = source
    ? await prisma.figureImage.findFirst({ where: { ...whereBase, source }, orderBy: { id: "asc" } })
    : null;
  if (!existing && sha256) {
    existing = await prisma.figureImage.findFirst({ where: { ...whereBase, sha256 }, orderBy: { id: "asc" } });
  }

  const payload = {
    figureId: input.figureId,
    janCode: input.janCode ?? null,
    sha256, size, format: input.format || "webp",
    width: input.width ?? null, height: input.height ?? null,
    fileSize: input.fileSize ?? null, alt: input.alt || null,
    sortOrder: input.sortOrder ?? 0, source, isNsfw: input.isNsfw || false,
    data: input.data ?? null,
  };

  const image = existing
    ? await prisma.figureImage.update({ where: { id: existing.id }, data: payload })
    : await prisma.figureImage.create({ data: payload });
  return { image, created: !existing };
}
