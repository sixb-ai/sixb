import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { assertCliSucceeded, runCliToCompletion } from "./shared/cli-process"

// A cold production build drives the custom-app and Atlas bundlers plus asset precompression. Keep
// that production work out of the parallel unit suite, and bound its child so a wedged bundler
// cannot consume the E2E job wall-clock timeout.

const BUILD_TIMEOUT_MS = 150_000

function buildTest(name: string, run: () => Promise<void>): void {
  test(name, run, BUILD_TIMEOUT_MS + 10_000)
}

async function runBuildEntry(entry: string, outdir: string) {
  const repoRoot = resolve(import.meta.dir, "..", "..", "..")
  const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")

  return await runCliToCompletion({
    cmd: ["bun", cliEntry, "build", "--entry", entry, "--outdir", outdir],
    cwd: repoRoot,
    timeoutMs: BUILD_TIMEOUT_MS,
  })
}

describe("sixb build", () => {
  const tempDirs: string[] = []
  const exampleEntry = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "examples",
    "roku-tv",
    "sixb.config.ts"
  )

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) {
        await rm(dir, { recursive: true, force: true })
      }
    }
  })

  buildTest("builds the custom app from the entry project root", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-cli-build-"))
    tempDirs.push(tempDir)
    const outdir = join(tempDir, "dist")

    const result = await runBuildEntry(exampleEntry, outdir)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Built")

    await stat(join(outdir, "sixb.config.js"))
    await stat(join(outdir, "app", "index.html"))
    const atlasAssets = await readdir(join(outdir, "atlas"))

    // Exactly one entry: the Atlas build splits, and chunks are named `chunk-*` so they can never
    // be mistaken for it.
    expect(atlasAssets.filter((file) => /^atlas-[^.]+\.js$/.test(file))).toHaveLength(1)
    expect(atlasAssets.filter((file) => /^atlas-[^.]+\.css$/.test(file))).toHaveLength(1)
    expect(atlasAssets.some((file) => /^chunk-.+\.js$/.test(file))).toBe(true)

    const html = await readFile(join(outdir, "app", "index.html"), "utf-8")
    expect(html).toContain('class="sixb-loading-shell"')
  })

  buildTest("does not overwrite custom app files watched by the dev server", async () => {
    const tempDir = await mkdtemp(join(dirname(exampleEntry), ".tmp-sixb-cli-build-isolation-"))
    tempDirs.push(tempDir)
    const appDir = join(tempDir, "app")
    const devGeneratedDir = join(tempDir, ".sixb", "generated")
    const entry = join(tempDir, "sixb.config.ts")
    const outdir = join(tempDir, "dist")
    await mkdir(appDir, { recursive: true })
    await mkdir(devGeneratedDir, { recursive: true })
    await writeFile(entry, "export default {}\n")
    await writeFile(join(appDir, "page.tsx"), "export default function Page() { return null }\n")

    const devFiles = new Map([
      ["index.html", "dev index with http://localhost:3000\n"],
      ["index.sixb-bundle.html", "dev HTML bundle entry\n"],
      ["main.tsx", "dev main entry\n"],
      ["routes.ts", "dev routes\n"],
      ["app.webmanifest", "dev manifest\n"],
    ])
    for (const [name, content] of devFiles) {
      await writeFile(join(devGeneratedDir, name), content)
    }

    const result = await runBuildEntry(entry, outdir)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    await stat(join(outdir, "app", "index.html"))
    for (const [name, content] of devFiles) {
      expect(await readFile(join(devGeneratedDir, name), "utf-8")).toBe(content)
    }
    await stat(join(tempDir, ".sixb", "build", "app", "index.html"))
  })

  buildTest("externalizes package dependencies when bundling runtime config", async () => {
    const repoRoot = resolve(import.meta.dir, "..", "..", "..")
    const tempDir = await mkdtemp(join(repoRoot, ".tmp-sixb-cli-build-packages-"))
    tempDirs.push(tempDir)
    const entry = join(tempDir, "sixb.config.ts")
    const outdir = join(tempDir, "dist")

    await writeFile(
      entry,
      [
        'import { DuckLakeStorage } from "@sixb/ducklake"',
        'import { sftp } from "@sixb/connector-sftp"',
        "",
        "export const duckLakeStorageConstructor = DuckLakeStorage",
        'export const sftpAdapter = sftp({ host: "example.com", username: "demo" })',
      ].join("\n")
    )

    const result = await runBuildEntry(entry, outdir)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const builtEntry = join(outdir, "sixb.config.js")
    await stat(builtEntry)

    const builtJs = await readFile(builtEntry, "utf-8")
    expect(builtJs).toContain('"@sixb/ducklake"')
    expect(builtJs).toContain('"@sixb/connector-sftp"')
    expect(builtJs).not.toContain("@duckdb/node-api")
    expect(builtJs).not.toContain("sshcrypto")

    const outputFiles = await readdir(outdir)
    expect(outputFiles.some((file) => file.endsWith(".node"))).toBe(false)
  })

  for (const factory of [false, true]) {
    const name = `shares built discovery with ${factory ? "factory" : "top-level"} config tools`
    buildTest(name, async () => {
      // Regression check: restore runBuild's old config-only Bun.build call and run this test.
      // The first built probe fails in ConnectorService with a different-instance error. The
      // source-free probe also requires discovery-only modules to belong to the built graph.
      const repoRoot = resolve(import.meta.dir, "..", "..", "..")
      const tempDir = await mkdtemp(join(repoRoot, ".tmp-sixb-cli-build-discovery-"))
      tempDirs.push(tempDir)
      const projectRoot = join(tempDir, "source")
      const deploymentRoot = join(tempDir, "deployment")
      const outdir = join(deploymentRoot, ".sixb", "dist")
      const entry = join(projectRoot, "sixb.config.ts")
      const config = `createSixb({
        broker: new InMemoryBroker(), storage: new InMemoryStorage(),
        lakeStorage: new InMemoryLakeStorage(), blobStorage: new InMemoryBlobStorage(),
        queues: new InMemoryQueues(), tools,
      })`
      const files = {
        "sixb.config.ts": `
          import { createSixb, InMemoryBroker, InMemoryStorage, InMemoryLakeStorage,
            InMemoryBlobStorage, InMemoryQueues } from "@sixb/core"
          import { tools } from "./connectors/exa"
          ${factory ? `export default async () => { await Promise.resolve(); return ${config} }` : `export const sixb = await ${config}`}
        `,
        "ontology/item.ts": `
          import { defineObjectType, prop } from "@sixb/core"
          export const Item = defineObjectType({
            id: "Item", name: "Item",
            properties: [prop("id", "string", { required: true, primary: true })],
          })
        `,
        "connectors/exa.ts": `
          import { defineAgentTool, defineConnector } from "@sixb/core"
          let connections = 0
          export const exa = defineConnector("exa", {
            type: "mock-exa",
            connect() { return { instance: ++connections, search: () => "search", fetch: () => "fetch" } },
          })
          export const tools = ["search", "fetch"].map(operation =>
            defineAgentTool("web_" + operation).description(operation).input({})
              .run(async ({ connector }) => {
                const client = await connector(exa)
                return { result: client[operation](), instance: client.instance }
              })
          )
        `,
        // Re-exports must deduplicate by identity, and unreferenced definitions must survive.
        "connectors/nested/extra.ts": `
          import { defineConnector } from "@sixb/core"
          export { exa } from "../exa"
          export const extra = defineConnector("extra", { type: "mock", connect: () => ({}) })
        `,
      }
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(projectRoot, path)), { recursive: true })
        await writeFile(join(projectRoot, path), content)
      }

      const probe = join(tempDir, "probe.ts")
      await writeFile(
        probe,
        `import { strict as assert } from "node:assert"
        import { createTestSixb } from "@sixb/core/testing"
        import { loadSixbFromEntry } from ${JSON.stringify(resolve(import.meta.dir, "../src/lib/loadSixb.ts"))}
        const host = await loadSixbFromEntry(process.argv[2])
        assert.deepEqual(host.definitions.ontology.listObjectTypes().map(type => type.id), ["Item"])
        assert.deepEqual(host.definitions.connectors.list().map(def => def.id), ["exa", "extra"])
        const sdk = createTestSixb(host)
        for (const operation of ["search", "fetch"]) {
          const tool = host.definitions.tools.getByName("web_" + operation)
          const output = await tool.handler({
            input: {}, signal: new AbortController().signal,
            connector: async definition => {
              const client = await sdk.connector(definition)
              assert.equal(host.definitions.connectors.getById(definition.id), definition)
              return client
            },
          })
          assert.deepEqual(output, { result: operation, instance: 1 })
        }
        await host.closeConnectors()
        console.log("tools resolved through registered connector")
        `
      )
      const probeEntry = async (runtimeEntry: string, cwd: string) => {
        const result = await runCliToCompletion({ cmd: ["bun", probe, runtimeEntry], cwd })
        assertCliSucceeded(result)
        expect(result.stderr).toBe("")
        expect(result.stdout).toContain("tools resolved through registered connector")
      }

      await probeEntry(entry, projectRoot)
      const build = await runBuildEntry(entry, outdir)
      assertCliSucceeded(build)
      expect(build.stderr).toBe("")
      const builtEntry = join(outdir, "sixb.config.js")
      await probeEntry(builtEntry, projectRoot)
      await rm(projectRoot, { recursive: true, force: true })
      await probeEntry(builtEntry, deploymentRoot)
    })
  }
})
