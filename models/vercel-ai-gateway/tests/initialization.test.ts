import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("bundled gateway initializes before declaring language and embedding models", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sixb-gateway-init-"))
  try {
    const output = join(directory, "gateway.mjs")
    // Bun 1.3.14's source loader tolerates the original declaration order; its bundle does not.
    // Regression proof: move vercelGateway above RemoteVercelGatewayCatalog and rerun this test.
    const build = Bun.spawnSync(
      [
        process.execPath,
        "build",
        join(import.meta.dir, "../src/index.ts"),
        "--target=bun",
        "--outfile",
        output,
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 10000 }
    )
    expect(build.exitCode).toBe(0)
    const run = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `
        const { vercelGateway } = await import(${JSON.stringify(output)});
        const language = vercelGateway("openai/test");
        const embedding = vercelGateway.embedding("openai/test", { dimensions: 3 });
        if (language.modelId !== "openai/test" || embedding.definition.dimensions !== 3)
          throw new Error("Model declaration failed");
      `,
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 10000 }
    )
    expect(run.stderr.toString()).toBe("")
    expect(run.exitCode).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 25000)
