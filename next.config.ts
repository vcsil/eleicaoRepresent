import type { NextConfig } from "next";

const supabaseHostname = (() => {
  try {
    return new URL(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://placeholder.supabase.co",
    ).hostname;
  } catch {
    return "placeholder.supabase.co";
  }
})();

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: supabaseHostname,
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
};

export default nextConfig;
