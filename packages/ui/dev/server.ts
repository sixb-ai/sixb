import app from "./index.html"

const server = Bun.serve({
  port: 3010,
  routes: {
    "/": app,
    "/*": app,
  },
  development: true,
})

console.log(`url: http://${server.hostname}:${server.port}/`)
