import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export async function writeProjectSkill(
  projectRoot: string,
  name: string,
  skillMd: string,
  files: Readonly<Record<string, string | Uint8Array>> = {}
): Promise<void> {
  const skillRoot = join(projectRoot, "skills", name)
  await mkdir(skillRoot, { recursive: true })
  await writeFile(join(skillRoot, "SKILL.md"), skillMd)
  for (const [path, contents] of Object.entries(files)) {
    const absolutePath = join(skillRoot, path)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, contents)
  }
}

/** Poll `fn` until it returns a truthy value or the timeout elapses (mirrors the action-worker helper). */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 3000
  const intervalMs = options.intervalMs ?? 10
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value !== null && value !== undefined && value !== false) {
      return value
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out${options.label ? `: ${options.label}` : ""}`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
