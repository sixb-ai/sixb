import type { CommandResult, Sandbox } from "@sixb/core"
import { AGENT_CLI_VERSION } from "../agent-cli/output"
import { AgentRuntimeProfileError } from "./errors"
import {
  AGENT_RUNTIME_MINIMUM_VERSIONS,
  AGENT_RUNTIME_PROFILE,
  type AgentDoctorReport,
  type AgentJavascriptRuntime,
  type AgentRuntimeFailureReason,
  type AgentRuntimeProfileCheck,
} from "./profile"

const PREFLIGHT_TIMEOUT_MS = 15_000

const CHECK_BY_EXIT_CODE: Readonly<Record<number, AgentRuntimeProfileCheck>> = {
  20: "environment-bootstrap",
  21: "path-bootstrap",
  22: "cli-installation",
  23: "file-tools",
  24: "javascript-runtime",
  25: "cli-execution",
}

export interface AssertAgentRuntimeProfileInput {
  readonly sandbox: Sandbox
  readonly env: Readonly<Record<string, string>>
  readonly projectId: string
}

/**
 * Validate the concrete provisioned environment before a model can use its sandbox tools.
 *
 * The first command is deterministic and network-free. The second deliberately travels through
 * the installed CLI and run-scoped gateway, proving the launcher, JavaScript fetch stack, gateway
 * capability, DNS, and TLS/CA path (when the configured gateway uses HTTPS) together.
 */
export async function assertAgentRuntimeProfile(
  input: AssertAgentRuntimeProfileInput
): Promise<void> {
  const local = await runProbe(input.sandbox, LOCAL_BEHAVIOR_PROBE, input.env, "bash")
  if (local.exitCode !== 0) {
    throw profileError(
      input.sandbox,
      CHECK_BY_EXIT_CODE[local.exitCode] ?? "bash",
      "nonzero-exit",
      local.exitCode
    )
  }

  const runtime = parseLocalProbe(input.sandbox, local.stdout)
  assertSupportedRuntime(input.sandbox, runtime.name, runtime.version)
  if (runtime.cliVersion !== AGENT_CLI_VERSION) {
    throw profileError(input.sandbox, "cli-execution", "invalid-output")
  }

  const gateway = await runProbe(input.sandbox, "sixb doctor", input.env, "gateway-connectivity")
  if (gateway.exitCode !== 0) {
    throw profileError(input.sandbox, "gateway-connectivity", "nonzero-exit", gateway.exitCode)
  }
  assertDoctorReport(input.sandbox, gateway.stdout, input.projectId, runtime)
}

async function runProbe(
  sandbox: Sandbox,
  script: string,
  env: Readonly<Record<string, string>>,
  failureCheck: AgentRuntimeProfileCheck
): Promise<CommandResult> {
  try {
    const result = await sandbox.runCommand("bash", ["-lc", script], {
      env,
      timeout: PREFLIGHT_TIMEOUT_MS,
    })
    if (result.timedOut) throw profileError(sandbox, failureCheck, "timed-out")
    return result
  } catch (error) {
    if (error instanceof AgentRuntimeProfileError) throw error
    throw profileError(sandbox, failureCheck, "command-error")
  }
}

function parseLocalProbe(
  sandbox: Sandbox,
  stdout: string
): {
  readonly name: AgentJavascriptRuntime
  readonly version: string
  readonly cliVersion: string
} {
  const fields = stdout.trim().split("\t")
  if (fields.length !== 3) throw profileError(sandbox, "cli-execution", "invalid-output")
  const [name, version, cliOutput] = fields
  if ((name !== "bun" && name !== "node") || !version || !cliOutput) {
    throw profileError(sandbox, "cli-execution", "invalid-output")
  }
  const prefix = "sixb agent CLI "
  if (!cliOutput.startsWith(prefix)) {
    throw profileError(sandbox, "cli-execution", "invalid-output")
  }
  return { name, version, cliVersion: cliOutput.slice(prefix.length) }
}

function assertSupportedRuntime(
  sandbox: Sandbox,
  name: AgentJavascriptRuntime,
  version: string
): void {
  const parsed = parseVersion(version)
  const minimum = AGENT_RUNTIME_MINIMUM_VERSIONS[name]
  if (
    !parsed ||
    parsed.major < minimum.major ||
    (parsed.major === minimum.major && parsed.minor < minimum.minor)
  ) {
    throw profileError(sandbox, "javascript-runtime", "unsupported-version")
  }
}

function parseVersion(version: string): { readonly major: number; readonly minor: number } | null {
  const match = /^v?(\d+)\.(\d+)(?:\.|$)/.exec(version.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]) }
}

function assertDoctorReport(
  sandbox: Sandbox,
  stdout: string,
  projectId: string,
  localRuntime: { readonly name: AgentJavascriptRuntime; readonly version: string }
): void {
  let report: AgentDoctorReport
  try {
    const value: unknown = JSON.parse(stdout)
    report = parseDoctorReport(value)
  } catch {
    throw profileError(sandbox, "cli-execution", "invalid-output")
  }
  if (
    report.cli.version !== AGENT_CLI_VERSION ||
    report.javascript.name !== localRuntime.name ||
    normalizeVersion(report.javascript.version) !== normalizeVersion(localRuntime.version)
  ) {
    throw profileError(sandbox, "cli-execution", "invalid-output")
  }
  if (report.project.id !== projectId) {
    throw profileError(sandbox, "gateway-connectivity", "invalid-output")
  }
}

function parseDoctorReport(value: unknown): AgentDoctorReport {
  const report = record(value)
  const cli = record(report.cli)
  const javascript = record(report.javascript)
  const project = record(report.project)
  if (
    report.ok !== true ||
    report.profile !== AGENT_RUNTIME_PROFILE ||
    typeof cli.version !== "string" ||
    cli.version.length === 0 ||
    (javascript.name !== "bun" && javascript.name !== "node") ||
    typeof javascript.version !== "string" ||
    javascript.version.length === 0 ||
    typeof project.id !== "string" ||
    project.id.length === 0
  ) {
    throw new Error("invalid doctor report")
  }
  return {
    ok: true,
    profile: report.profile,
    cli: { version: cli.version },
    javascript: { name: javascript.name, version: javascript.version },
    project: { id: project.id },
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object")
  }
  return value as Record<string, unknown>
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/, "")
}

function profileError(
  sandbox: Sandbox,
  check: AgentRuntimeProfileCheck,
  reason: AgentRuntimeFailureReason,
  exitCode?: number
): AgentRuntimeProfileError {
  return new AgentRuntimeProfileError(sandbox.provider, check, reason, exitCode)
}

const LOCAL_BEHAVIOR_PROBE = `set -u
[ "\${SIXB_BASH_ENV_READY:-}" = "1" ] || exit 20
[ "\${SIXB_AGENT_RUNTIME_PROFILE:-}" = "${AGENT_RUNTIME_PROFILE}" ] || exit 20
[ "$(command -v sixb)" = "$SIXB_BIN_DIR/sixb" ] || exit 21
[ -x "$SIXB_BIN_DIR/sixb" ] || exit 22
[ -r "$SIXB_CONTEXT_DIR/lib/sixb.mjs" ] || exit 22
realpath_bin="$(command -v realpath)" || exit 23
tail_bin="$(command -v tail)" || exit 23
head_bin="$(command -v head)" || exit 23
base64_bin="$(command -v base64)" || exit 23
resolved_probe="$("$realpath_bin" "$SIXB_RUNTIME_PROBE_FILE")" || exit 23
[ -f "$resolved_probe" ] || exit 23
"$tail_bin" -n "+2" -- "$resolved_probe" | "$head_bin" -n 1 | "$head_bin" -c 19 | "$base64_bin" > "$SIXB_CONTEXT_DIR/runtime/read-probe.out"
for status in "\${PIPESTATUS[@]}"; do
  case "$status" in 0|141) ;; *) exit 23 ;; esac
done
IFS= read -r read_probe < "$SIXB_CONTEXT_DIR/runtime/read-probe.out"
[ "$read_probe" = "c2l4Yi1ydW50aW1lLXByb2JlCg==" ] || exit 23
find_bin="$(command -v find)" || exit 23
wc_bin="$(command -v wc)" || exit 23
tr_bin="$(command -v tr)" || exit 23
probe_dir="\${resolved_probe%/*}"
"$find_bin" "$probe_dir" -type f -name "read-probe.txt" -print0 | while IFS= read -r -d '' path; do
  size="$("$wc_bin" -c < "$path" | "$tr_bin" -d ' ')" || exit 1
  encoded="$(printf '%s' "$path" | "$base64_bin" | "$tr_bin" -d '\n')" || exit 1
  printf '%s\t%s\n' "$size" "$encoded"
done > "$SIXB_CONTEXT_DIR/runtime/file-tools-probe.out"
for status in "\${PIPESTATUS[@]}"; do
  [ "$status" = "0" ] || exit 23
done
IFS=$'\t' read -r file_size encoded_path < "$SIXB_CONTEXT_DIR/runtime/file-tools-probe.out"
[ "$file_size" = "31" ] || exit 23
decoded_path="$(printf '%s' "$encoded_path" | "$base64_bin" -d)" || exit 23
[ "$decoded_path" = "$resolved_probe" ] || exit 23
runtime_path="$(command -v bun || true)"
if [ -n "$runtime_path" ]; then
  runtime_name="bun"
  runtime_version="$("$runtime_path" --version)" || exit 24
else
  runtime_path="$(command -v node || true)"
fi
if [ -z "\${runtime_name:-}" ] && [ -n "$runtime_path" ]; then
  runtime_name="node"
  runtime_version="$("$runtime_path" --version)" || exit 24
fi
if [ -z "\${runtime_name:-}" ]; then
  exit 24
fi
cli_version="$(sixb --version)" || exit 25
printf '%s\t%s\t%s\n' "$runtime_name" "$runtime_version" "$cli_version"`
