/**
 * Runs a command to completion, quietly unless it fails: then it throws `failure` and its errors.
 * Resolves with what it printed, for the commands whose answer is their output.
 */
export async function run(
  command: readonly string[],
  failure: string,
  options: { readonly timeoutMs?: number } = {}
): Promise<string> {
  const child = Bun.spawn([...command], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs ?? 120_000,
  })
  const [exitCode, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) {
    const detail = errors.trim() || output.trim()
    throw new Error(`[SixbDesktop] ${failure}${detail ? `\n${detail}` : ""}`)
  }
  return output
}
