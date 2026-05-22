import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { ParioServer } from "@pario/server"
import { renderParioS4ConfigSource } from "../src/render-config"
import { createParioTestProject, type TestPario } from "./helpers/fixtures"

test("S4 CLI reaches the Pario API through a renderer-produced s4.config.ts", async () => {
  const { pario } = await createParioTestProject()
  const port = await getFreePort()
  const server = createTestServer(pario, port)
  // Tmp dir lives under tests/ so workspace module resolution (@pario/s4-provider,
  // @s4/runtime) succeeds when s4 dynamic-imports the rendered config.
  const cwd = await mkdtemp(join(import.meta.dir, ".tmp-s4-cli-"))
  await writeFile(join(cwd, "s4.config.ts"), renderParioS4ConfigSource())

  await server.start()

  try {
    await expect(runS4Cli(cwd, port, "cat", "/pario/status.json")).resolves.toContain(
      '"status": "ok"'
    )
    await expect(runS4Cli(cwd, port, "ls", "/pario/syncs")).resolves.toBe(
      "index.json\nsync-devices/"
    )
  } finally {
    await server.stop()
    await rm(cwd, { recursive: true, force: true })
  }
})

async function runS4Cli(cwd: string, port: number, ...args: readonly string[]): Promise<string> {
  const s4Bin = resolve(import.meta.dir, "../../../vendor/s4/packages/cli/src/bin.ts")
  const proc = Bun.spawn(["bun", s4Bin, ...args], {
    cwd,
    env: {
      ...process.env,
      PARIO_API_URL: `http://127.0.0.1:${port}`,
    },
    stderr: "pipe",
    stdout: "pipe",
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(`S4 CLI failed with exit ${exitCode}:\n${stderr}`)
  }

  return stdout.trim()
}

function createTestServer(pario: TestPario, port: number): ParioServer {
  const ParioServerConstructor = ParioServer as unknown as new (options: {
    readonly pario: unknown
    readonly host: string
    readonly port: number
    readonly quiet: boolean
    readonly ui: boolean
  }) => ParioServer

  return new ParioServerConstructor({
    pario,
    host: "127.0.0.1",
    port,
    quiet: true,
    ui: false,
  })
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

      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolvePromise(port)
      })
    })
  })
}
