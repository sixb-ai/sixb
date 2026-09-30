import type {
  DeployContext,
  DeployControlAction,
  DeployLogsOptions,
  DeployRelease,
  DeploySource,
  DeployStatus,
} from "@sixb/core/deploy"
import { deploymentLayout } from "./layout"
import {
  renderDeployScript,
  renderPrepareScript,
  renderReceiveScript,
  STEP_MARKER,
} from "./scripts"
import { stripTerminalControl } from "./server/logs"
import { shellQuote } from "./shell"
import { RemoteScriptError, type RemoteShell } from "./transport"

const NOT_DEPLOYED = "__SIXB_NOT_DEPLOYED__"

/** Uploads the source, then runs the release on the server as one locked script. */
export async function deployRelease(
  shell: RemoteShell,
  user: string,
  release: DeployRelease,
  source: DeploySource,
  context: DeployContext
): Promise<void> {
  const prepared = await capture(shell, renderPrepareScript(release.name, source.commit))
  const [home, incoming] = prepared
  if (!home || !incoming) {
    throw new Error("[SshTarget] The server did not report its home directory.")
  }

  const layout = deploymentLayout({
    home,
    user,
    name: release.name,
    projectPath: source.projectPath,
    bunVersion: release.bunVersion,
  })
  const { labels, script } = renderDeployScript({
    release,
    layout,
    incoming,
    record: {
      commit: source.commit,
      ref: source.ref,
      deployedAt: new Date().toISOString(),
      deployedBy: context.deployedBy,
    },
  })
  context.report({ type: "steps", labels: ["Upload source", ...labels] })

  context.report({ type: "step", index: 0, status: "running" })
  for (const archive of source.archives) {
    await shell.run(renderReceiveScript(incoming, archive.path), { stdin: archive.open() })
  }
  context.report({ type: "step", index: 0, status: "done" })

  await runReportingSteps(shell, script, context)
}

/** Runs the deploy script, turning its step markers into progress and the rest into output. */
async function runReportingSteps(
  shell: RemoteShell,
  script: string,
  context: DeployContext
): Promise<void> {
  const run = shell.run(script, {
    onLine: (line) => {
      const [marker, index, status] = line.split("\t")
      if (marker === STEP_MARKER && (status === "start" || status === "done")) {
        const step = Number(index) + 1
        context.report({
          type: "step",
          index: step,
          status: status === "start" ? "running" : "done",
        })
      } else {
        const output = stripTerminalControl(line)
        if (output.trim()) context.report({ type: "output", line: output })
      }
    },
  })
  try {
    await run
  } catch (error) {
    // The step's output already reached `report`; repeating it here would print it twice.
    if (error instanceof RemoteScriptError && error.exitCode !== 255) {
      throw new Error(`[SshTarget] The step exited with code ${error.exitCode}.`)
    }
    throw error
  }
}

export async function readStatus(shell: RemoteShell, name: string): Promise<DeployStatus> {
  const lines = await capture(shell, ctlScript(name, ["status", "--json"], { allowMissing: true }))
  const report = lines.find((line) => line.startsWith("{"))
  if (lines.includes(NOT_DEPLOYED) || !report) {
    return { release: null, running: false, processes: [] }
  }
  return JSON.parse(report) as DeployStatus
}

export async function streamLogs(
  shell: RemoteShell,
  name: string,
  options: DeployLogsOptions & { readonly terminal?: boolean }
): Promise<void> {
  const args = [
    "logs",
    ...(options.service ? [options.service] : []),
    "--tail",
    String(options.tail),
    ...(options.follow ? ["--follow"] : []),
  ]
  await shell.run(ctlScript(name, args), {
    ...(options.terminal ? { terminal: true } : { onLine: (line: string) => options.write(line) }),
  })
}

export async function controlServices(
  shell: RemoteShell,
  name: string,
  action: DeployControlAction,
  service: string | undefined
): Promise<void> {
  await shell.run(ctlScript(name, [action, ...(service ? [service] : [])]))
}

/** Runs the deployment's `ctl` with arguments; fails plainly when nothing is deployed yet. */
function ctlScript(
  name: string,
  args: readonly string[],
  options: { readonly allowMissing?: boolean } = {}
): string {
  return [
    `ctl="$HOME"/${shellQuote(name)}/deploy/ctl`,
    'if [ ! -x "$ctl" ]; then',
    options.allowMissing
      ? `  echo ${NOT_DEPLOYED}; exit 0`
      : `  echo "Nothing named ${name} is deployed on this server yet." >&2; exit 1`,
    "fi",
    `exec "$ctl" ${args.map(shellQuote).join(" ")}`,
  ].join("\n")
}

async function capture(shell: RemoteShell, script: string): Promise<string[]> {
  const lines: string[] = []
  await shell.run(script, {
    onLine: (line, stream) => {
      if (stream === "stdout") lines.push(line)
    },
  })
  return lines
}
