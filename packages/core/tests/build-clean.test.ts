import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("build cleanup preserves example data while removing package output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sixb-build-clean-"))
  try {
    const rootPackage = await Bun.file(join(import.meta.dir, "../../../package.json")).json()
    await Bun.write(
      join(directory, "package.json"),
      JSON.stringify({
        scripts: { "build:clean": rootPackage.scripts["build:clean"] },
      })
    )
    const data = join(directory, "examples/northline/.sixb/storage.sqlite")
    const output = join(directory, "packages/core/dist/index.js")
    await mkdir(join(directory, "examples/northline/.sixb"), { recursive: true })
    await mkdir(join(directory, "packages/core/dist"), { recursive: true })
    await Bun.write(data, "local runtime data")
    await Bun.write(output, "generated output")
    // Regression proof: restoring examples/*/.sixb in build:clean deletes this data fixture.
    const result = Bun.spawnSync([process.execPath, "run", "build:clean"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    })
    expect(result.exitCode).toBe(0)
    expect(await Bun.file(data).exists()).toBe(true)
    expect(await Bun.file(data).text()).toBe("local runtime data")
    expect(await Bun.file(output).exists()).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
