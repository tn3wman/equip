import { createHash } from "node:crypto";
import type { Store } from "./storage.ts";

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

export function rateLimitKey(namespace: string, value: string): string {
  return `${namespace}:${createHash("sha256").update(value).digest("hex")}`;
}

export class PersistentRateLimiter {
  constructor(private readonly store: Store) {}

  async consume(
    key: string,
    limit: number,
    windowMs: number,
    now = Date.now(),
  ): Promise<RateLimitResult> {
    if (limit < 1 || windowMs < 1) throw new Error("Invalid rate limit.");
    return this.store.transaction(async transaction => {
      await transaction.run(
        "INSERT INTO auth_rate_limits(key,count,expires_at) VALUES(?,?,?) ON CONFLICT DO NOTHING",
        key,
        0,
        now + windowMs,
      );
      const lock = transaction.dialect === "postgres" ? " FOR UPDATE" : "";
      const row = await transaction.get<{ count: number | string; expires_at: number | string }>(
        `SELECT count,expires_at FROM auth_rate_limits WHERE key=?${lock}`,
        key,
      );
      if (!row) throw new Error("Rate limit row was not created.");
      const expiresAt = Number(row.expires_at);
      const count = expiresAt <= now ? 1 : Number(row.count) + 1;
      const nextExpiry = expiresAt <= now ? now + windowMs : expiresAt;
      await transaction.run(
        "UPDATE auth_rate_limits SET count=?,expires_at=? WHERE key=?",
        count,
        nextExpiry,
        key,
      );
      return {
        allowed: count <= limit,
        retryAfterSeconds: Math.max(1, Math.ceil((nextExpiry - now) / 1000)),
      };
    });
  }

  async reset(key: string): Promise<void> {
    await this.store.run("DELETE FROM auth_rate_limits WHERE key=?", key);
  }

  async cleanup(now = Date.now()): Promise<void> {
    await this.store.run("DELETE FROM auth_rate_limits WHERE expires_at<=?", now);
  }
}
