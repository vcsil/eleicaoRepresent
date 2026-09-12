import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { getServerEnv } from "@/lib/env";

/** HMAC-SHA256 do IP com o segredo do servidor — nunca armazenamos o IP puro. */
export function hashIp(ip: string): string {
  const { APP_SECRET_KEY } = getServerEnv();
  return createHmac("sha256", APP_SECRET_KEY).update(ip).digest("hex");
}

/** Hash usado para chaves de rate limiting derivadas de dados sensíveis (ex.: matrícula). */
export function hashKey(value: string): string {
  const { APP_SECRET_KEY } = getServerEnv();
  return createHmac("sha256", APP_SECRET_KEY).update(value).digest("hex");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateSecureToken(): string {
  return randomBytes(32).toString("hex");
}
