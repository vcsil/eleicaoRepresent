import "server-only";
import { z } from "zod";

const serverEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ADMIN_PASSWORD_HASH: z.string().min(1),
  APP_SECRET_KEY: z.string().min(16),
});

let cached: z.infer<typeof serverEnvSchema> | null = null;

/** Lê e valida as variáveis de ambiente do servidor uma única vez. */
export function getServerEnv() {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH,
    APP_SECRET_KEY: process.env.APP_SECRET_KEY,
  });

  if (!parsed.success) {
    throw new Error(
      `Variáveis de ambiente ausentes ou inválidas: ${parsed.error.issues
        .map((i) => i.path.join("."))
        .join(", ")}`,
    );
  }

  cached = parsed.data;
  return cached;
}
