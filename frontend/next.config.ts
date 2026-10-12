import type { NextConfig } from "next";

/**
 * Two build targets from one codebase:
 * - default: a Node server (`output: "standalone"`) that reads its configuration from the environment per request;
 * - BUILD_TARGET=static (`npm run build:static`): a fully static bundle in `out/` that reads `config.json` at
 *   runtime. Every page is exported one directory deep (`trade/index.html`, ...) and assets are referenced as
 *   `../_next/...`, so the bundle works from any sub-path without a rebuild.
 */
const isStatic = process.env.BUILD_TARGET === "static";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingRoot: __dirname,
  env: { NEXT_PUBLIC_BUILD_TARGET: isStatic ? "static" : "standalone" },
  ...(isStatic
    ? {
        output: "export" as const,
        trailingSlash: true,
        assetPrefix: "..",
        images: { unoptimized: true },
      }
    : {
        output: "standalone" as const,
        // A real HTTP redirect for the bare origin (the static bundle does this in out/index.html).
        redirects: async () => [{ source: "/", destination: "/trade", permanent: false }],
      }),
};

export default nextConfig;
