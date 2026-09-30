#!/usr/bin/env bun
import { readFile } from "node:fs/promises"
import type { DeployRecord, DeployStatus } from "@sixb/core/deploy"
import { followLogFiles, type LogLine, readRecentLogLines, renderProcessLogLine } from "./logs"
import { loadProcessManifest, type ProcessManifest, statePath } from "./manifest"
import { isMissing, isPidRunning, readProcessState } from "./state"
import { runSupervisor, type SupervisorCommand, sendSupervisorCommand } from "./supervisor"

/**
 * The server half of `@sixb/deploy-ssh`. Each deployment runs it through its `deploy/ctl`
 * script, which pins the Bun version and manifest. `sixb deploy` reaches it over SSH.
 *
 *   supervise                       run the deployment's processes (the systemd unit's command)
 *   status [--json] [--check]       --check exits 1 unless every process is running
 *   logs [service] [--tail n] [--follow]
 *   restart|start|stop [service]
 */
const argv = process.argv.slice(2)

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

async function main(): Promise<void> {
  const manifestPath = option("--manifest")
  if (!manifestPath) throw new Error("[SshTarget] --manifest is required.")
  const [command, service] = positionals()

  switch (command) {
    case "supervise":
      await runSupervisor(manifestPath)
      // Its signal listeners would keep Bun running after every process has stopped.
      return process.exit(0)
    case "status":
      return status(await loadProcessManifest(manifestPath))
    case "logs":
      return logs(await loadProcessManifest(manifestPath), service)
    case "restart":
    case "start":
    case "stop":
      console.log(
        await sendSupervisorCommand(
          await loadProcessManifest(manifestPath),
          command satisfies SupervisorCommand,
          service
        )
      )
      return
    default:
      throw new Error(`[SshTarget] Unknown command '${command ?? ""}'.`)
  }
}

async function status(manifest: ProcessManifest): Promise<void> {
  const state = await readProcessState(statePath(manifest))
  const running = state !== null && isPidRunning(state.supervisorPid)
  const report: DeployStatus = {
    release: await readRelease(manifest.releasePath),
    running,
    processes: running
      ? state.instances.map((instance) => ({
          service: instance.service,
          instance: instance.instance,
          status: instance.status,
          restarts: instance.restarts,
          ...(instance.pid === undefined ? {} : { pid: instance.pid }),
          ...(instance.startedAt === undefined ? {} : { startedAt: instance.startedAt }),
          ...(instance.cpuPercent === undefined ? {} : { cpuPercent: instance.cpuPercent }),
          ...(instance.memoryBytes === undefined ? {} : { memoryBytes: instance.memoryBytes }),
          ...(instance.lastError === undefined ? {} : { lastError: instance.lastError }),
        }))
      : [],
  }

  if (flag("--check")) {
    // Right after a deploy, any restart means a process already exited once.
    const down = report.processes.filter(
      (process) => process.status !== "running" || process.restarts > 0
    )
    if (!running) console.error("The supervisor is not running.")
    for (const process of down) {
      const label =
        process.instance === 0 ? process.service : `${process.service}#${process.instance}`
      const state = process.status === "running" ? `restarted ${process.restarts}x` : process.status
      console.error(`${label} ${state}${process.lastError ? `: ${process.lastError}` : ""}`)
    }
    if (!running || down.length > 0) process.exit(1)
    return
  }
  console.log(JSON.stringify(report))
}

async function logs(manifest: ProcessManifest, service: string | undefined): Promise<void> {
  const targets = manifest.services
    .filter((candidate) => !service || candidate.name === service)
    .flatMap((candidate) =>
      Array.from({ length: candidate.instances }, (_, instance) => ({
        path: `${manifest.logDir}/${candidate.processName}-${instance}.log`,
        label: instance === 0 ? candidate.name : `${candidate.name}#${instance}`,
      }))
    )
  if (targets.length === 0) {
    throw new Error(
      `[SshTarget] No service named '${service}'. ` +
        `Services: ${manifest.services.map((candidate) => candidate.name).join(", ")}.`
    )
  }

  const labels = new Map(targets.map((target) => [target.path, target.label]))
  const labelWidth = Math.max(...targets.map((target) => target.label.length))
  const print = (item: LogLine) => {
    const line = renderProcessLogLine(item, { label: labels.get(item.path) ?? "", labelWidth })
    if (line !== null) console.log(line)
  }

  const paths = targets.map((target) => target.path)
  for (const item of await readRecentLogLines(paths, Number(option("--tail") ?? 100))) print(item)
  if (!flag("--follow")) return

  const controller = new AbortController()
  // SIGHUP arrives when the SSH connection that asked for the logs goes away.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => controller.abort())
  }
  await followLogFiles(paths, print, { signal: controller.signal })
}

async function readRelease(path: string): Promise<DeployRecord | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as DeployRecord
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

function option(name: string): string | undefined {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

function flag(name: string): boolean {
  return argv.includes(name)
}

function positionals(): string[] {
  const values: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? ""
    if (argument === "--manifest" || argument === "--tail") index++
    else if (!argument.startsWith("--")) values.push(argument)
  }
  return values
}
