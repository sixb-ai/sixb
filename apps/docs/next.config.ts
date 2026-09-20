import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { NextConfig } from "next"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..")

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: "/fundamentals/data-flow", destination: "/#explore-the-code", permanent: true },
      { source: "/data", destination: "/#explore-the-code", permanent: true },
      ...["connectors", "datasets", "syncs", "pipelines", "projections"].map((name) => ({
        source: `/data/${name}`,
        destination: `/${name}`,
        permanent: true,
      })),
      { source: "/connector", destination: "/connectors", permanent: true },
      {
        source: "/ontology/search-metadata",
        destination: "/ontology/properties",
        permanent: true,
      },
      {
        source: "/runtime/error-handling",
        destination: "/runtime/error-codes#failure-notifications",
        permanent: true,
      },
    ]
  },
  transpilePackages: ["@sixb/ui"],
  turbopack: {
    root: repoRoot,
  },
}

export default nextConfig
