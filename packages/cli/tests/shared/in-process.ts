import { spyOn } from "bun:test"
import { format } from "node:util"

export interface InProcessRun {
  /** What the command printed to stdout, without colors. */
  readonly output: string
  readonly stderr: string
  /** What the command threw, when it threw. */
  readonly error?: unknown
  /** The code the command passed to `process.exit()` or set as `process.exitCode`. */
  readonly exitCode?: number
}

class ProcessExit {
  constructor(readonly code: number) {}
}

/**
 * Runs a CLI command handler in the test process. It collects what the command prints (Ink writes
 * to `process.stdout`; Bun's `console` does not go through it), turns `process.exit()` into a
 * result instead of the end of the test run, and puts back the environment the command changed
 * (production roles set NODE_ENV) and the process exit code.
 */
export async function runInProcess(command: () => Promise<unknown>): Promise<InProcessRun> {
  const stdout: string[] = []
  const stderr: string[] = []
  const environment = { ...process.env }
  // Bun ignores `process.exitCode = undefined`, so 0 stands for "not set".
  const exitCode = process.exitCode ?? 0
  process.exitCode = 0
  const collect =
    (chunks: string[]) =>
    (chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
      return true
    }
  const spies = [
    spyOn(process.stdout, "write").mockImplementation(
      collect(stdout) as typeof process.stdout.write
    ),
    spyOn(process.stderr, "write").mockImplementation(
      collect(stderr) as typeof process.stderr.write
    ),
    ...(["log", "info", "warn"] as const).map((method) =>
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        stdout.push(`${format(...args)}\n`)
      })
    ),
    spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(`${format(...args)}\n`)
    }),
    spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ProcessExit(code ?? 0)
    }) as typeof process.exit),
  ]

  let ending: Pick<InProcessRun, "error" | "exitCode"> = {}
  try {
    await command()
    const setCode = Number(process.exitCode ?? 0)
    if (setCode !== 0) ending = { exitCode: setCode }
  } catch (error) {
    ending = error instanceof ProcessExit ? { exitCode: error.code } : { error }
  } finally {
    for (const spy of spies) spy.mockRestore()
    for (const name of Object.keys(process.env)) {
      if (!(name in environment)) delete process.env[name]
    }
    Object.assign(process.env, environment)
    process.exitCode = exitCode
  }

  return {
    output: Bun.stripANSI(stdout.join("")),
    stderr: Bun.stripANSI(stderr.join("")),
    ...ending,
  }
}
