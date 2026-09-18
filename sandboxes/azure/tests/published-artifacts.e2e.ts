import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repository = resolve(import.meta.dir, "../../..")

/** Pack and load from outside the checkout: workspace aliases must not hide missing assets. */
test("packed provider loads both exports, provisions its guest artifact and resolves consumer types", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sixb-azure-consumer-"))
  try {
    const modules = join(directory, "node_modules")
    await mkdir(join(modules, "@sixb"), { recursive: true })
    // Reuse installed third-party dependencies, but extract all Sixb dependencies from tarballs.
    for (const entry of await readdir(join(repository, "node_modules"))) {
      if (entry === "@sixb" || entry === "create-sixb" || entry === "@azure") continue
      await symlink(await realpath(join(repository, "node_modules", entry)), join(modules, entry))
    }
    await symlink(
      await realpath(join(repository, "sandboxes/azure/node_modules/@azure")),
      join(modules, "@azure")
    )
    for (const [source, name] of [
      ["packages/core", "core"],
      ["sandboxes/azure", "sandboxes-azure"],
    ] as const) {
      const tarball = join(directory, `${name}.tgz`)
      await run([process.execPath, "pm", "pack", "--filename", tarball], join(repository, source))
      const destination = join(modules, "@sixb", name)
      await mkdir(destination)
      await run(["tar", "-xzf", tarball, "--strip-components=1", "-C", destination], directory)
    }
    const packageRoot = join(modules, "@sixb/sandboxes-azure")
    expect(await Bun.file(join(packageRoot, "dist/guest/supervisor.mjs")).exists()).toBe(true)
    expect(await Bun.file(join(packageRoot, "scripts/prepare-agent-image.ts")).exists()).toBe(false)
    for (const specifier of [
      "@sixb/sandboxes-azure",
      "./node_modules/@sixb/sandboxes-azure/dist/index.js",
    ]) {
      await writeFile(join(directory, "consumer.mjs"), consumer(specifier))
      await run([process.execPath, "consumer.mjs"], directory)
    }
    // Negative control: remove the guest asset from the installed package. Provisioning must
    // fail with the actionable missing-artifact error, not silently rely on the repository.
    const artifact = join(packageRoot, "dist/guest/supervisor.mjs")
    const source = await Bun.file(artifact).text()
    await rm(artifact)
    const missing = await run([process.execPath, "consumer.mjs"], directory, false)
    expect(missing.code).not.toBe(0)
    expect(missing.stderr).toContain("supervisor artifact is unavailable")
    await writeFile(artifact, source)

    await writeFile(
      join(directory, "types.ts"),
      `
import { AzureSandboxFactory, type AzureSandboxFactoryOptions } from "@sixb/sandboxes-azure"
import type { SandboxFactory } from "@sixb/core/sandboxes"
const options: AzureSandboxFactoryOptions = {
  subscriptionId: "subscription", resourceGroup: "group", sandboxGroup: "sandboxes",
  region: "westus3", image: { type: "public", name: "node-22" },
  credential: { getToken: async () => ({ token: "test", expiresOnTimestamp: 1 }) },
}
const factory: SandboxFactory = new AzureSandboxFactory(options)
void factory
`
    )
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          skipLibCheck: true,
          types: ["bun"],
        },
        files: ["types.ts"],
      })
    )
    await run(
      [
        process.execPath,
        join(repository, "node_modules/typescript/bin/tsc"),
        "-p",
        "tsconfig.json",
      ],
      directory
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 240_000)

async function run(command: string[], cwd: string, success = true) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" })
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    child.kill()
  }, 60_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (expired || (success && code !== 0))
      throw new Error(`Consumer check failed (${code}): ${stdout}${stderr}`)
    return { code, stderr }
  } finally {
    clearTimeout(timer)
  }
}

function consumer(specifier: string): string {
  return `
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { AzureSandboxFactory } from ${JSON.stringify(specifier)}
let deleted = false
let uploads = 0
const artifact = await readFile("./node_modules/@sixb/sandboxes-azure/dist/guest/supervisor.mjs", "utf8").catch(() => "")
globalThis.fetch = async (input, init) => {
  const url = new URL(input)
  if (init.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }) }
  if (init.method === "GET") { assert(deleted); return new Response(null, { status: 404 }) }
  if (url.pathname.endsWith("/files")) {
    if (url.searchParams.get("path").endsWith("/supervisor.mjs")) {
      assert.equal(await new Response(init.body).text(), artifact)
      uploads++
    }
    return new Response(null, { status: 204 })
  }
  if (init.method === "PUT") return Response.json({ id: "consumer-sandbox", state: "Running" })
  const { command } = JSON.parse(init.body)
  return Response.json({ exitCode: 0, stdout: command.includes(" init ") ? '{"state":"ready"}' : "", stderr: "" })
}
const factory = new AzureSandboxFactory({ subscriptionId: "subscription", resourceGroup: "group", sandboxGroup: "sandboxes", region: "westus3", image: { type: "public", name: "node-22" }, credential: { getToken: async () => ({ token: "synthetic", expiresOnTimestamp: Date.now() + 60000 }) } })
const sandbox = await factory.create()
assert.equal(sandbox.status, "running")
assert.equal(uploads, 1)
await sandbox.destroy()
assert(deleted)
`
}
