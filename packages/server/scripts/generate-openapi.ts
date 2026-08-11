/**
 * Generates the OpenAPI spec JSON by starting a temporary SixbHost server,
 * fetching /docs/json, and writing it to packages/client/openapi.json.
 */

import { createServer } from "node:net"
import { resolve } from "node:path"
import type { OntologySource } from "@sixb/core"
import {
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"
import { SixbServer } from "../src/server"

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

      const { port } = address
      server.close((error) => {
        if (error) reject(error)
        else resolvePromise(port)
      })
    })
  })
}

async function main() {
  const System = defineObjectType({
    id: "System",
    name: "System",
    properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
  })

  const host: SixbHost<readonly OntologySource[]> = new SixbHost<readonly OntologySource[]>({
    id: "openapi-gen",
    ontology: [System] as readonly OntologySource[],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })

  const port = await getFreePort()
  const publicOrigin = `http://127.0.0.1:${port}`
  const server = new SixbServer({
    host,
    hostname: "127.0.0.1",
    port,
    quiet: true,
    browser: {
      publicOrigin,
      allowedOrigins: [{ origin: publicOrigin, audience: "atlas" }],
    },
  })
  await server.start()

  const res = await fetch(`${publicOrigin}/docs/json`)
  if (!res.ok) {
    console.error(`Failed to fetch OpenAPI spec: ${res.status} ${res.statusText}`)
    process.exit(1)
  }

  const spec = await res.json()
  const outputPath = resolve(import.meta.dir, "../../client/openapi.json")
  await Bun.write(outputPath, `${formatOpenApiJson(spec)}\n`)
  console.log(`OpenAPI spec written to ${outputPath}`)

  await server.stop()
  process.exit(0)
}

/** Keep primitive schema lists compact so generated API changes remain reviewable. */
function formatOpenApiJson(spec: unknown): string {
  const lines = JSON.stringify(spec, null, 2).split("\n")

  for (let start = lines.length - 1; start >= 0; start -= 1) {
    const opening = lines[start]
    const match = /^(\s*).*\[$/.exec(opening)
    if (!match) continue

    const indentation = match[1]
    const values: string[] = []
    let end = start + 1
    for (; end < lines.length; end += 1) {
      const line = lines[end]
      if (line === `${indentation}]` || line === `${indentation}],`) break
      const serialized = line.trim().replace(/,$/, "")
      if (!isPrimitiveJson(serialized)) break
      values.push(serialized)
    }
    if (end >= lines.length || values.length === 0) continue

    const closing = lines[end].endsWith(",") ? "]," : "]"
    const compact = `${opening}${values.join(", ")}${closing}`
    if (compact.length > 100) continue
    lines.splice(start, end - start + 1, compact)
  }

  return lines.join("\n")
}

function isPrimitiveJson(serialized: string): boolean {
  try {
    const value = JSON.parse(serialized)
    return value === null || typeof value !== "object"
  } catch {
    return false
  }
}

main()
