import { FastifyInstance } from "fastify";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { userGuard, requireActiveUser, type UserIdentity } from "../plugins/user-auth/guard.js";

const commentSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

function publicUser(user: any) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    role: user.role,
    createdAt: user.createdAt,
  };
}

async function findFigure(app: FastifyInstance, slug: string, reply: any) {
  const figure = await app.prisma.figure.findFirst({
    where: { slug, isDeleted: false },
    select: { id: true, slug: true, name: true },
  });

  if (!figure) {
    reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND", message: "Figure not found" } });
    return null;
  }

  return figure;
}

function isSafeDisplayImage(image: any): boolean {
  if (!image) return false;
  const w = Number(image.width) || 0;
  const h = Number(image.height) || 0;
  const source = String(image.source || image.url || "");
  // Check metadata for official image designation (M4: trust分级)
  const metaData: any = (image as any).data || {};
  const sourceKind = String(metaData.source_kind || "");
  const safeDisplay = metaData.safe_display === true;
  // MFC /upload/pictures/: only allow if marked official_item_image
  if (source.includes("myfigurecollection.net/upload/pictures/")) {
    return sourceKind === "official_item_image" && safeDisplay;
  }
  // MFC /upload/items/: only allow if marked official_item_thumbnail
  if (source.includes("/upload/items/")) {
    return sourceKind === "official_item_thumbnail" && safeDisplay;
  }
  if (w === 0 || h === 0) return true;
  const ratio = Math.max(w, h) / Math.min(w, h);
  if (ratio > 3.5) return false;
  if (w < 300 && h < 300) return false;
  return true;
}

function compactFigure(figure: any) {
  const safeImages = (figure.images || []).filter((img: any) => isSafeDisplayImage(img));
  const firstImage = safeImages[0] || null;
  return {
    id: figure.id,
    slug: figure.slug,
    name: figure.name,
    nameEn: figure.nameEn,
    nameJp: figure.nameJp,
    releaseDate: figure.releaseDate,
    image: firstImage ? { ...firstImage, url: `/api/v1/figures/images/${firstImage.id}` } : null,
  };
}


// security-patched: 清理用户输入中的控制字符
// HTML 转义由前端 esc()/textContent 处理，后端做深度防御
function sanitizeUserText(s: string): string {
  var cleaned = String(s || "");
  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return cleaned;
}

export async function communityRoutes(app: FastifyInstance) {
  const prisma: PrismaClient = app.prisma;

  // READ route: unverified users allowed (can view their space, resend verification, etc.)
  app.get("/me/space", { preHandler: userGuard }, async (req: any, reply: any) => {
    const identity = req.user as UserIdentity;
    const user = await prisma.user.findUnique({
      where: { id: BigInt(identity.userId) },
      select: { id: true, email: true, displayName: true, avatarUrl: true, role: true, isActive: true, createdAt: true },
    });
    if (!user || !user.isActive) {
      return reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED", message: "账号不可用" } });
    }

    const [favorites, likes, comments] = await Promise.all([
      prisma.favorite.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 60,
        include: {
          figure: {
            include: {
              images: {
                orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
                take: 1,
                select: { id: true, alt: true, width: true, height: true, source: true, size: true, data: true },
              },
            },
          },
        },
      }),
      prisma.figureLike.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 60,
        include: {
          figure: {
            include: {
              images: {
                orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
                take: 1,
                select: { id: true, alt: true, width: true, height: true, source: true, size: true, data: true },
              },
            },
          },
        },
      }),
      prisma.figureComment.findMany({
        where: { userId: user.id, isDeleted: false },
        orderBy: { createdAt: "desc" },
        take: 60,
        include: { figure: { select: { id: true, slug: true, name: true, nameEn: true, nameJp: true } } },
      }),
    ]);

    return {
      success: true,
      data: {
        user: publicUser(user),
        favorites: favorites.map((item: any) => ({ id: item.id, createdAt: item.createdAt, figure: compactFigure(item.figure) })),
        likes: likes.map((item: any) => ({ id: item.id, createdAt: item.createdAt, figure: compactFigure(item.figure) })),
        comments: comments.map((item: any) => ({
          id: item.id,
          body: item.body,
          createdAt: item.createdAt,
          figure: item.figure,
        })),
      },
    };
  });

  app.get("/figures/:slug/social", async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const figure = await prisma.figure.findFirst({
      where: { slug, isDeleted: false },
      select: { id: true },
    });
    if (!figure) return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND" } });

    let userId: bigint | null = null;
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ") && auth.length > 7) {
      try {
        const payload = app.jwt.verify<{ userId: string | number; role: string }>(auth.slice(7));
        userId = BigInt(payload.userId);
      } catch {
        userId = null;
      }
    }

    const [favoriteCount, likeCount, commentCount, favorite, like] = await Promise.all([
      prisma.favorite.count({ where: { figureId: figure.id } }),
      prisma.figureLike.count({ where: { figureId: figure.id } }),
      prisma.figureComment.count({ where: { figureId: figure.id, isDeleted: false } }),
      userId ? prisma.favorite.findUnique({ where: { userId_figureId: { userId, figureId: figure.id } } }) : null,
      userId ? prisma.figureLike.findUnique({ where: { userId_figureId: { userId, figureId: figure.id } } }) : null,
    ]);

    return {
      success: true,
      data: {
        counts: { favorites: favoriteCount, likes: likeCount, comments: commentCount },
        viewer: { favorited: Boolean(favorite), liked: Boolean(like) },
      },
    };
  });

  // WRITE route: requires verified email. Unverified → 403 EMAIL_NOT_VERIFIED.
  app.post("/figures/:slug/favorite", { preHandler: requireActiveUser }, async (req: any, reply: any) => {
    const userId = BigInt(req.user.userId);
    const figure = await findFigure(app, (req.params as { slug: string }).slug, reply);
    if (!figure) return;

    const favorite = await prisma.favorite.upsert({
      where: { userId_figureId: { userId, figureId: figure.id } },
      create: { userId, figureId: figure.id },
      update: {},
    });

    return { success: true, data: { favorited: true, favoriteId: favorite.id } };
  });

  app.delete("/figures/:slug/favorite", { preHandler: requireActiveUser }, async (req: any, reply: any) => {
    const userId = BigInt(req.user.userId);
    const figure = await findFigure(app, (req.params as { slug: string }).slug, reply);
    if (!figure) return;

    await prisma.favorite.deleteMany({ where: { userId, figureId: figure.id } });
    return { success: true, data: { favorited: false } };
  });

  app.post("/figures/:slug/like", { preHandler: requireActiveUser }, async (req: any, reply: any) => {
    const userId = BigInt(req.user.userId);
    const figure = await findFigure(app, (req.params as { slug: string }).slug, reply);
    if (!figure) return;

    const like = await prisma.figureLike.upsert({
      where: { userId_figureId: { userId, figureId: figure.id } },
      create: { userId, figureId: figure.id },
      update: {},
    });

    return { success: true, data: { liked: true, likeId: like.id } };
  });

  app.delete("/figures/:slug/like", { preHandler: requireActiveUser }, async (req: any, reply: any) => {
    const userId = BigInt(req.user.userId);
    const figure = await findFigure(app, (req.params as { slug: string }).slug, reply);
    if (!figure) return;

    await prisma.figureLike.deleteMany({ where: { userId, figureId: figure.id } });
    return { success: true, data: { liked: false } };
  });

  app.get("/figures/:slug/comments", async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const figure = await prisma.figure.findFirst({ where: { slug, isDeleted: false }, select: { id: true } });
    if (!figure) return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND" } });

    const comments = await prisma.figureComment.findMany({
      where: { figureId: figure.id, isDeleted: false },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        body: true,
        createdAt: true,
        user: { select: { id: true, displayName: true, avatarUrl: true } },
      },
    });

    return { success: true, data: comments };
  });

  app.post("/figures/:slug/comments", { preHandler: requireActiveUser, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req: any, reply: any) => {
    const userId = BigInt(req.user.userId);
    const figure = await findFigure(app, (req.params as { slug: string }).slug, reply);
    if (!figure) return;
    const { body } = commentSchema.parse(req.body);
    // 安全：清洗评论内容，移除控制字符（HTML转义由前端处理，但后端做深度防御）
    const sanitizedBody = sanitizeUserText(body);

    const comment = await prisma.figureComment.create({
      data: { userId, figureId: figure.id, body: sanitizedBody },
      select: {
        id: true,
        body: true,
        createdAt: true,
        user: { select: { id: true, displayName: true, avatarUrl: true } },
      },
    });

    return reply.status(201).send({ success: true, data: comment });
  });
}
