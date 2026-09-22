import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { NextConfig } from "next"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..")

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: "/auth", destination: "/auth/authentication", permanent: true },
      { source: "/auth/overview.md", destination: "/auth/authentication.md", permanent: true },
      { source: "/events", destination: "/websockets", permanent: true },
      { source: "/events/overview.md", destination: "/websockets/overview.md", permanent: true },
      { source: "/runtime/error-codes", destination: "/errors", permanent: true },
      { source: "/runtime/error-codes.md", destination: "/errors/overview.md", permanent: true },
      { source: "/objects/crud", destination: "/objects", permanent: true },
      {
        source: "/objects/crud.md",
        destination: "/objects/overview.md",
        permanent: true,
      },
      {
        source: "/objects/http-reference",
        destination: "/server/object-queries",
        permanent: true,
      },
      {
        source: "/objects/http-reference.md",
        destination: "/server/object-queries.md",
        permanent: true,
      },
      {
        source: "/schedules/events",
        destination: "/schedules#run-on-an-event",
        permanent: true,
      },
      {
        source: "/schedules/events.md",
        destination: "/schedules/overview.md",
        permanent: true,
      },
      {
        source: "/models/built-in-agent",
        destination: "/models#built-in-agent",
        permanent: true,
      },
      {
        source: "/models/built-in-agent.md",
        destination: "/models/overview.md",
        permanent: true,
      },
      ...["local", "apple-container", "smolvm", "vercel"].flatMap((provider) =>
        ["", ".md"].map((extension) => ({
          source: `/sandboxes/${provider}${extension}`,
          destination: `https://github.com/sixb-ai/sixb/tree/main/sandboxes/${provider}#readme`,
          permanent: true,
        }))
      ),
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
        destination: "/logging#report-failures",
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
