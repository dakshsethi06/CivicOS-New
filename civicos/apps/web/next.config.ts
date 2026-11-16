import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every signed-in page reads the session cookie, so pages render per request.
  // Cache Components can be adopted later, route by route.
  // complaint photos (up to 5 MB) are posted through a server action
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
