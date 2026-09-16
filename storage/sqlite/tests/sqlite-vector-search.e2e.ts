import { expect, test } from "bun:test"

test("SQLite vector search uses sqlite-vec with authorized exact top-k", async () => {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/vector-search.ts`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 20000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toContain("Vector search:")
  } finally {
    clearTimeout(timer)
    child.kill()
  }
}, 25000)
