import { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { PrismaClient } from "@prisma/client";

export const prismaPlugin = fp(async (app: FastifyInstance) => {
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });

  await prisma.$connect();
  app.decorate("prisma", prisma);

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
});

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}
