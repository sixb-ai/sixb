import { fileURLToPath } from "node:url"

/** Build in a bounded child: never run Bun.build inside the test process. */
export async function buildGuestArtifact(): Promise<void> {
  const child = Bun.spawn([process.execPath, "run", "build:guest"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000)
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (status !== 0) throw new Error(`Guest artifact build failed: ${stdout}${stderr}`)
  } finally {
    clearTimeout(timer)
  }
}
