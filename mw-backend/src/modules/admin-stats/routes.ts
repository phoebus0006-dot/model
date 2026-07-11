import { FastifyInstance } from "fastify";

export async function adminStatsRoutes(app: FastifyInstance) {
  app.get("/stats", async () => {
    const [figures, manufacturers, series, sculptors, categories, characters, users, images] = await Promise.all([
      app.prisma.figure.count({ where: { isDeleted: false } }),
      app.prisma.manufacturer.count(),
      app.prisma.series.count(),
      app.prisma.sculptor.count(),
      app.prisma.category.count(),
      app.prisma.character.count(),
      app.prisma.user.count(),
      app.prisma.figureImage.count(),
    ]);
    const [recentFigures, upcomingReleases, topManufacturers] = await Promise.all([
      app.prisma.figure.findMany({ where: { isDeleted: false }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, slug: true, name: true, nameEn: true, createdAt: true } }),
      app.prisma.figure.findMany({ where: { isDeleted: false, releaseDate: { gte: new Date() } }, orderBy: { releaseDate: "asc" }, take: 5, select: { id: true, slug: true, name: true, nameEn: true, releaseDate: true, priceJpy: true } }),
      app.prisma.manufacturer.findMany({ orderBy: { figures: { _count: "desc" } }, take: 10, select: { id: true, slug: true, name: true, _count: { select: { figures: true } } } }),
    ]);
    return { success: true, data: { counts: { figures, manufacturers, series, sculptors, categories, characters, users, images }, recentFigures, upcomingReleases, topManufacturers } };
  });
}
