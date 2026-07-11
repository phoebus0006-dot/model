import type { Redis } from "ioredis";
import type { ReviewItem, ReviewDecision, ReviewRecord } from "./types.js";

export interface ReviewItemData {
  item: ReviewItem;
  raw: string;
}

export class ReviewRepository {
  constructor(private redis: Redis) {}

  async getAllItemIds(): Promise<string[]> {
    return this.redis.zrevrange("review:items", 0, -1);
  }

  async getItem(id: string): Promise<ReviewItemData | null> {
    const raw = await this.redis.get(`review:item:${id}`);
    if (!raw) return null;
    try {
      return { item: JSON.parse(raw), raw };
    } catch {
      return null;
    }
  }

  async saveItem(id: string, item: ReviewItem): Promise<void> {
    await this.redis.set(`review:item:${id}`, JSON.stringify(item));
  }

  async addToIndex(id: string, score?: number): Promise<void> {
    await this.redis.zadd("review:items", score ?? Date.now(), id);
  }

  async getDecision(key: string): Promise<ReviewDecision | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async saveDecision(key: string, decision: ReviewDecision): Promise<void> {
    await this.redis.set(key, JSON.stringify(decision));
    await this.redis.zadd("review:decisions", Date.now(), key);
  }

  async getAllDecisionKeys(): Promise<string[]> {
    return this.redis.zrevrange("review:decisions", 0, -1);
  }

  async getArchiveCount(): Promise<number> {
    return this.redis.zcard("review:archive");
  }

  async getAllItemsRaw(): Promise<Array<{ id: string; raw: string }>> {
    const ids = await this.getAllItemIds();
    const results: Array<{ id: string; raw: string }> = [];
    for (const id of ids) {
      const raw = await this.redis.get(`review:item:${id}`);
      if (raw) results.push({ id, raw });
    }
    return results;
  }

  async generateId(): Promise<string> {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
