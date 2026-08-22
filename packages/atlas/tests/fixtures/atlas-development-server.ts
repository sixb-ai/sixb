import assert from "node:assert/strict"
import { createServer } from "node:net"
import { createAtlasApp } from "../../src"

const port = await getFreePort()
const atlas = createAtlasApp({
  apiBaseUrl: "http://api.localhost",
  audience: "atlas",
  authEnabled: false,
})
const server = await atlas.start({
  host: "127.0.0.1",
  port,
  development: true,
})

try {
  const baseUrl = `http://127.0.0.1:${port}`
  const rootResponse = await fetch(`${baseUrl}/`)
  const routeResponse = await fetch(`${baseUrl}/devices`)
  const faviconResponse = await fetch(`${baseUrl}/favicon.svg`)
  const runtimeResponse = await fetch(`${baseUrl}/__sixb/runtime.json`)
  const apiResponse = await fetch(`${baseUrl}/api/project`)

  assert.equal(rootResponse.status, 200)
  assert.equal(routeResponse.status, 200)
  assert.equal(faviconResponse.status, 200)
  assert.equal(runtimeResponse.status, 200)
  assert.deepEqual(await runtimeResponse.json(), {
    api: { baseUrl: "http://api.localhost" },
    auth: { audience: "atlas", enabled: false },
  })
  assert.equal(apiResponse.status, 404)
} finally {
  await server.stop()
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const server = createServer() as ReturnType<typeof createServer> & {
      on(event: string, listener: (error: Error) => void): void
    }

    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve an open port"))
        return
      }

      server.close((error) => {
        if (error) reject(error)
        else resolvePromise(address.port)
      })
    })
  })
}
