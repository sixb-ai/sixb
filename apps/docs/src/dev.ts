import app from "../index.html"
import { docsConfig } from "./docs/config"

type BunServeRoutes = NonNullable<Parameters<typeof Bun.serve>[0]["routes"]>

const routes: BunServeRoutes = {
  "/": app,
  "/*": app,
}

for (const doc of docsConfig) {
  routes[doc.routePath] = app
  routes[doc.markdownPath] = {
    GET: () => markdownResponse(doc.sourcePath),
    HEAD: () => markdownHeadResponse(),
  }
}

const server = Bun.serve({
  port: 3004,
  development: true,
  routes,
} as Parameters<typeof Bun.serve>[0])

console.log(`url: http://${server.hostname}:${server.port}/`)

function markdownResponse(sourcePath: string): Response {
  return new Response(Bun.file(sourcePath), {
    headers: markdownHeaders(),
  })
}

function markdownHeadResponse(): Response {
  return new Response(null, {
    headers: markdownHeaders(),
  })
}

function markdownHeaders(): HeadersInit {
  return {
    "content-type": "text/markdown; charset=utf-8",
    "cache-control": "no-store",
  }
}
