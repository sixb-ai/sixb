import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Async spawn with a kill timer: Bun.spawnSync inside a parallel test worker can miss its
// child's exit and hang the worker.
async function run(cmd: string[]) {
  const child = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
  try {
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ])
    return { exitCode, stderr }
  } finally {
    clearTimeout(timer)
  }
}

test("bundled gateway initializes before declaring language and embedding models", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sixb-gateway-init-"))
  try {
    const output = join(directory, "gateway.mjs")
    // Bun 1.3.14's source loader tolerates the original declaration order; its bundle does not.
    // Regression proof: move vercelGateway above RemoteVercelGatewayCatalog and rerun this test.
    const build = await run([
      process.execPath,
      "build",
      join(import.meta.dir, "../src/index.ts"),
      "--target=bun",
      "--outfile",
      output,
    ])
    expect(build.exitCode).toBe(0)
    const declared = await run([
      process.execPath,
      "-e",
      `
        const { vercelGateway } = await import(${JSON.stringify(output)});
        const language = vercelGateway("openai/test");
        const embedding = vercelGateway.embedding("openai/test", { dimensions: 3 });
        if (language.modelId !== "openai/test" || embedding.definition.dimensions !== 3)
          throw new Error("Model declaration failed");
      `,
    ])
    expect(declared.stderr).toBe("")
    expect(declared.exitCode).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 25000)
