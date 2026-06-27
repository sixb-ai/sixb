import app from "./index.html"

const port = Number.parseInt(Bun.env.PORT ?? "3010", 10)

if (!Number.isFinite(port)) {
  throw new Error("[SixbUI] PORT must be a number")
}

const server = Bun.serve({
  port,
  routes: {
    "/": app,
    "/*": app,
  },
  development: true,
})

console.log(`url: http://${server.hostname}:${server.port}/`)
