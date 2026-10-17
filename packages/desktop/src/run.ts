/** Runs a command to completion, quietly unless it fails: then it throws `failure` and its errors. */
export async function run(command: readonly string[], failure: string): Promise<void> {
  const child = Bun.spawn([...command], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 120_000,
  })
  const [exitCode, errors] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exitCode !== 0) {
    throw new Error(`[SixbDesktop] ${failure}${errors.trim() ? `\n${errors.trim()}` : ""}`)
  }
}
