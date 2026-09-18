import { beforeAll, expect, test } from "bun:test"
import type { AzureSandboxClient } from "../src/azure-client"
import { installSupervisor } from "../src/command-execution"
import { buildGuestArtifact } from "./guest-build"

beforeAll(buildGuestArtifact, 20_000)

test("guest artifact is standalone Node JavaScript with only built-in imports", async () => {
  // Negative control: change build:guest to copy supervisor.ts to the output.
  // The JavaScript parser must reject its TypeScript interfaces/type annotations.
  const source = await Bun.file(new URL("../dist/guest/supervisor.mjs", import.meta.url)).text()
  const scanned = new Bun.Transpiler({ loader: "js", target: "node" }).scan(source)
  expect(scanned.imports.length).toBeGreaterThan(0)
  expect(scanned.imports.every(({ path }) => path.startsWith("node:"))).toBe(true)
  expect(scanned.exports).toEqual([])
  expect(source).not.toContain("Bun.")
  expect(source).not.toContain("require_")
})

test("source provider uploads the compiled artifact without running it on the worker", async () => {
  let uploaded: string | Uint8Array | undefined
  const unused = async (): Promise<never> => {
    throw new Error("unexpected operation")
  }
  const client: AzureSandboxClient = {
    create: unused,
    get: unused,
    stop: unused,
    delete: unused,
    setEgressPolicy: unused,
    execute: async (_id, command) => ({
      exitCode: 0,
      stdout: command.includes(" init ") ? '{"state":"ready"}' : "",
      stderr: "",
    }),
    writeFile: async (_id, path, contents, mode) => {
      expect(mode).toBe(0o600)
      if (path.endsWith("/network.json")) {
        expect(contents).toBe('{"connected":false}')
      } else {
        expect(path).toEndWith("/supervisor.mjs")
        uploaded = contents
      }
    },
  }
  await installSupervisor(client, "sandbox", "/workspace", new AbortController().signal)
  expect(uploaded).toBe(
    await Bun.file(new URL("../dist/guest/supervisor.mjs", import.meta.url)).text()
  )
})
