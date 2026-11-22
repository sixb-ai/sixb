/// <reference path="./sh.d.ts" />
import { randomUUID } from "node:crypto"
import type {
  DeployContext,
  DeployControlAction,
  DeployLogsOptions,
  DeployRelease,
  DeployScript,
  DeploySource,
  DeployStatus,
} from "@sixb/core/deploy"
import bootstrap from "./bootstrap.sh" with { type: "text" }
import { deriveReleaseId, parseEvent, type ReleasePlan, releaseStepLabels } from "./plan"
import { stripTerminalControl } from "./server/logs"
import { shellQuote } from "./shell"
import { RemoteScriptError, type RemoteShell } from "./transport"

const NOT_DEPLOYED = "__SIXB_NOT_DEPLOYED__"

/**
 * Uploads the source and the plan, starts the release on the server detached from this
 * connection, and follows its log until it ends. A dropped connection leaves the deploy running.
 */
export async function deployRelease(
  shell: RemoteShell,
  release: DeployRelease,
  source: DeploySource,
  context: DeployContext
): Promise<void> {
  const record = {
    commit: source.commit,
    ref: source.ref,
    deployedAt: new Date().toISOString(),
    deployedBy: context.deployedBy,
  }
  const releaseId = deriveReleaseId(record)
  const [home, incoming] = await capture(
    shell,
    [
      `root="$HOME"/${shellQuote(release.name)}`,
      'mkdir -p "$root/deploy/incoming" "$root/deploy/runs"',
      // Run logs hold all the build and migration output: for the deploy account alone.
      'chmod 700 "$root/deploy/runs"',
      `incoming="$(mktemp -d "$root/deploy/incoming/${releaseId}.XXXXXX")"`,
      // `mktemp` makes it 0700, and tar passes the mode of the upload's `.` on to the release.
      'chmod 755 "$incoming"',
      `printf '%s\n%s\n' "$HOME" "$incoming"`,
    ].join("\n")
  )
  if (!home || !incoming)
    throw new Error("[SshTarget] The server did not report its home directory.")

  const labels = releaseStepLabels(release)
  context.report({ type: "steps", labels })
  context.report({ type: "step", index: 0, status: "running" })
  for (const archive of source.archives) {
    const directory = archive.path === "." ? incoming : `${incoming}/${archive.path}`
    await shell.run(
      `mkdir -p ${shellQuote(directory)} && tar -x -f - -C ${shellQuote(directory)}`,
      { stdin: archive.open() }
    )
  }
  const runs = `${home}/${release.name}/deploy/runs`
  const plan: ReleasePlan = {
    version: 1,
    release,
    record,
    releaseId,
    projectPath: source.projectPath,
  }
  const files = { plan: `${runs}/${releaseId}.json`, script: `${runs}/${releaseId}.sh` }
  await upload(shell, files.plan, JSON.stringify(plan))
  await upload(shell, files.script, bootstrap)
  context.report({ type: "step", index: 0, status: "done" })

  const log = `${runs}/${releaseId}.log`
  const args = [
    release.name,
    releaseId,
    source.projectPath,
    release.bunVersion,
    incoming,
    files.plan,
  ]
  const [pid] = await capture(
    shell,
    `setsid nohup bash ${[files.script, ...args].map(shellQuote).join(" ")} > ${shellQuote(log)} 2>&1 < /dev/null & echo $!`
  )
  await follow(shell, { pid: pid ?? "", log, labels, context })
}

/** Reads the release's log as it grows, until the release ends, and reports its progress. */
async function follow(
  shell: RemoteShell,
  input: {
    readonly pid: string
    readonly log: string
    readonly labels: readonly string[]
    readonly context: DeployContext
  }
): Promise<void> {
  const { context, labels } = input
  let exit: number | null = null
  let failure: string | null = null
  try {
    await shell.run(
      `tail -n +1 -F --pid=${shellQuote(input.pid)} ${shellQuote(input.log)} 2> /dev/null`,
      {
        onLine: (line, stream) => {
          if (stream !== "stdout") return
          const event = parseEvent(line)
          if (event && "exit" in event) {
            exit = event.exit
          } else if (event) {
            const index = labels.indexOf(event.step)
            if (index === -1) context.report({ type: "output", line: event.step })
            else context.report({ type: "step", index, status: event.status })
          } else {
            const output = stripTerminalControl(line)
            if (output.startsWith("[SshTarget] ")) failure = output
            if (output.trim()) context.report({ type: "output", line: output })
          }
        },
      }
    )
  } catch (error) {
    throw new Error(
      `[SshTarget] Lost the connection while following the deploy, which carries on on the server. \`sixb deploy status\` shows the release once it ends; its log is ${input.log}.`,
      { cause: error }
    )
  }
  if (exit === 0) return
  // The step's output already reached `report`; the error repeats only its conclusion.
  throw new Error(failure ?? `[SshTarget] The deploy ended with code ${exit ?? "unknown"}.`)
}

async function upload(shell: RemoteShell, path: string, content: string): Promise<void> {
  await shell.run(`umask 077 && cat > ${shellQuote(path)}`, {
    stdin: new Blob([content]).stream(),
  })
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

/**
 * Uploads the script, then runs it through `ctl run` in a terminal on the server: Ctrl-C reaches
 * the script there, and so does a dropped connection, as a hangup. Holding the deploy lock shared
 * for the whole run keeps a deploy from replacing the code it imports or migrating its storage;
 * runs share it with each other. Resolves with the script's exit code.
 */
export async function runDeployScript(
  shell: RemoteShell,
  name: string,
  script: DeployScript
): Promise<number> {
  const root = `"$HOME"/${shellQuote(name)}`
  const staged = `${root}/deploy/runs/${randomUUID()}`
  await shell.run(
    [
      `if [ ! -x ${root}/deploy/ctl ]; then`,
      `  echo "Nothing named ${name} is deployed on this server yet." >&2; exit 1`,
      "fi",
      "umask 077",
      `mkdir -p ${root}/deploy/runs`,
      // An upload whose run never started is left behind; a day later it goes.
      `find ${root}/deploy/runs -type f -mmin +1440 -delete 2> /dev/null || true`,
      `cat > ${staged}`,
    ].join("\n"),
    { stdin: new Blob([Uint8Array.from(script.source)]).stream() }
  )

  const run = [
    `cd ${root}`,
    `exec 9> ${root}/deploy/lock`,
    "if ! flock -s -n 9; then",
    `  echo "Waiting for a deploy of ${name} to finish…" >&2`,
    "fi",
    "if ! flock -s -w 600 9; then",
    `  echo "A deploy of ${name} has held its lock for 10 minutes." >&2`,
    `  rm -f ${staged}`,
    "  exit 1",
    "fi",
    `exec ${root}/deploy/ctl run ${staged} ${[script.path, ...script.args].map(shellQuote).join(" ")}`,
  ].join("\n")
  try {
    await shell.run(run, { terminal: true })
    return 0
  } catch (error) {
    // 255 is OpenSSH's own failure; any other code is the script's.
    if (error instanceof RemoteScriptError && error.exitCode !== 255) return error.exitCode
    throw error
  }
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
