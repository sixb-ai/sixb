import {
  resolveStartProcessPlan,
  type StartOptions,
  type StartProcessSpec,
} from "../lib/start-process-plan"
import { ErrorView, renderStatic } from "../ui"

interface RunningStartProcess {
  readonly spec: StartProcessSpec
  readonly process: ReturnType<typeof Bun.spawn>
}

export async function runStart(options: StartOptions = {}) {
  process.env.NODE_ENV = "production"

  const running: RunningStartProcess[] = []
  let shuttingDown = false

  try {
    const plan = await resolveStartProcessPlan(options)

    console.log(`Starting pario production roles for ${plan.projectId}`)
    for (const warning of plan.warnings) {
      console.warn(`[start] ${warning}`)
    }

    for (const spec of plan.specs) {
      const child = spawnRole(spec)
      running.push(child)
      pipeOutput(child)
      console.log(`[start] ${spec.role}: started`)
    }

    const failure = waitForUnexpectedExit(running, () => shuttingDown)
    const signal = waitForSignal()
    const result = await Promise.race([failure, signal])

    shuttingDown = true
    if (result.kind === "signal") {
      console.log(`\n[start] received ${result.signal}; stopping roles...`)
      await stopRunningProcesses(running)
      return
    }

    console.error(
      `[start] ${result.role} exited with code ${result.exitCode}. Stopping remaining roles...`
    )
    await stopRunningProcesses(running)
    process.exit(result.exitCode === 0 ? 1 : result.exitCode)
  } catch (error) {
    shuttingDown = true
    await stopRunningProcesses(running)
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}

function spawnRole(spec: StartProcessSpec): RunningStartProcess {
  return {
    spec,
    process: Bun.spawn([process.execPath, process.argv[1] ?? "pario", ...spec.args], {
      cwd: process.cwd(),
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }),
  }
}

function pipeOutput(child: RunningStartProcess): void {
  void prefixStream(child.process.stdout, child.spec.role, (line) => process.stdout.write(line))
  void prefixStream(child.process.stderr, child.spec.role, (line) => process.stderr.write(line))
}

async function prefixStream(
  stream: unknown,
  role: string,
  write: (line: string) => void
): Promise<void> {
  if (!(stream instanceof ReadableStream)) return

  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      write(`[${role}] ${line}\n`)
    }
  }

  buffer += decoder.decode()
  if (buffer.length > 0) {
    write(`[${role}] ${buffer}\n`)
  }
}

async function waitForUnexpectedExit(
  children: readonly RunningStartProcess[],
  isShuttingDown: () => boolean
): Promise<{ kind: "exit"; role: string; exitCode: number }> {
  return await Promise.race(
    children.map(async (child) => {
      const exitCode = await child.process.exited
      if (isShuttingDown()) {
        return await new Promise<{ kind: "exit"; role: string; exitCode: number }>(() => {})
      }
      return { kind: "exit" as const, role: child.spec.role, exitCode }
    })
  )
}

async function waitForSignal(): Promise<{ kind: "signal"; signal: "SIGINT" | "SIGTERM" }> {
  return await new Promise((resolvePromise) => {
    process.once("SIGINT", () => resolvePromise({ kind: "signal", signal: "SIGINT" }))
    process.once("SIGTERM", () => resolvePromise({ kind: "signal", signal: "SIGTERM" }))
  })
}

async function stopRunningProcesses(children: readonly RunningStartProcess[]): Promise<void> {
  for (const child of [...children].reverse()) {
    child.process.kill("SIGTERM")
  }

  await Promise.race([
    Promise.all(children.map((child) => child.process.exited.catch(() => 1))),
    Bun.sleep(5_000).then(() => {
      for (const child of children) {
        child.process.kill("SIGKILL")
      }
    }),
  ])
}
