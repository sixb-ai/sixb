import type { CommandResult, Sandbox } from "@sixb/core"
import { AGENT_CLI_VERSION } from "../agent-cli/output"
import { AgentRuntimeProfileError } from "./errors"
import {
  AGENT_RUNTIME_MINIMUM_VERSIONS,
  AGENT_RUNTIME_PROFILE,
  type AgentJavascriptRuntime,
  type AgentRuntimeInfo,
  type AgentRuntimeProfileCheck,
} from "./profile"

const PREFLIGHT_TIMEOUT_MS = 15_000

const CHECK_BY_EXIT_CODE: Readonly<Record<number, AgentRuntimeProfileCheck>> = {
  20: "environment-bootstrap",
  21: "environment-bootstrap",
  22: "path-bootstrap",
  23: "cli-installation",
  24: "cli-installation",
  25: "read-tool",
  26: "read-tool",
  27: "read-tool",
  28: "read-tool",
  29: "javascript-runtime",
  30: "read-tool",
  31: "cli-execution",
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
): Promise<AgentRuntimeInfo> {
  const local = await runProbe(input.sandbox, LOCAL_BEHAVIOR_PROBE, input.env, "bash")
  if (local.exitCode !== 0) {
    throw profileError(input.sandbox, CHECK_BY_EXIT_CODE[local.exitCode] ?? "bash")
  }

  const runtime = parseLocalProbe(input.sandbox, local.stdout)
  assertSupportedRuntime(input.sandbox, runtime.name, runtime.version)
  if (runtime.cliVersion !== AGENT_CLI_VERSION) {
    throw profileError(input.sandbox, "cli-execution")
  }

  const gateway = await runProbe(
    input.sandbox,
    "sixb project show",
    input.env,
    "gateway-connectivity"
  )
  if (gateway.exitCode !== 0) {
    throw profileError(input.sandbox, "gateway-connectivity")
  }
  assertGatewayProject(input.sandbox, gateway.stdout, input.projectId)

  return {
    profile: AGENT_RUNTIME_PROFILE,
    provider: input.sandbox.provider,
    javascript: { name: runtime.name, version: runtime.version },
    cliVersion: runtime.cliVersion,
  }
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
    if (result.timedOut) throw profileError(sandbox, failureCheck)
    return result
  } catch (error) {
    if (error instanceof AgentRuntimeProfileError) throw error
    throw profileError(sandbox, failureCheck)
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
  if (fields.length !== 3) throw profileError(sandbox, "cli-execution")
  const [name, version, cliOutput] = fields
  if ((name !== "bun" && name !== "node") || !version || !cliOutput) {
    throw profileError(sandbox, "cli-execution")
  }
  const prefix = "sixb agent CLI "
  if (!cliOutput.startsWith(prefix)) throw profileError(sandbox, "cli-execution")
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
    throw profileError(sandbox, "javascript-runtime")
  }
}

function parseVersion(version: string): { readonly major: number; readonly minor: number } | null {
  const match = /^v?(\d+)\.(\d+)(?:\.|$)/.exec(version.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]) }
}

function assertGatewayProject(sandbox: Sandbox, stdout: string, projectId: string): void {
  try {
    const value: unknown = JSON.parse(stdout)
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("id" in value) ||
      value.id !== projectId
    ) {
      throw profileError(sandbox, "gateway-connectivity")
    }
  } catch (error) {
    if (error instanceof AgentRuntimeProfileError) throw error
    throw profileError(sandbox, "gateway-connectivity")
  }
}

function profileError(sandbox: Sandbox, check: AgentRuntimeProfileCheck): AgentRuntimeProfileError {
  return new AgentRuntimeProfileError(sandbox.provider, check)
}

const LOCAL_BEHAVIOR_PROBE = `set -u
[ "\${SIXB_BASH_ENV_READY:-}" = "1" ] || exit 20
[ "\${SIXB_AGENT_RUNTIME_PROFILE:-}" = "${AGENT_RUNTIME_PROFILE}" ] || exit 21
[ "$(command -v sixb)" = "$SIXB_BIN_DIR/sixb" ] || exit 22
[ -x "$SIXB_BIN_DIR/sixb" ] || exit 23
[ -r "$SIXB_CONTEXT_DIR/lib/sixb.mjs" ] || exit 24
realpath_bin="$(command -v realpath)" || exit 25
tail_bin="$(command -v tail)" || exit 26
head_bin="$(command -v head)" || exit 27
base64_bin="$(command -v base64)" || exit 28
resolved_probe="$("$realpath_bin" "$SIXB_RUNTIME_PROBE_FILE")" || exit 30
[ -f "$resolved_probe" ] || exit 30
"$tail_bin" -n "+2" -- "$resolved_probe" | "$head_bin" -n 1 | "$head_bin" -c 19 | "$base64_bin" > "$SIXB_CONTEXT_DIR/runtime/read-probe.out"
for status in "\${PIPESTATUS[@]}"; do
  case "$status" in 0|141) ;; *) exit 30 ;; esac
done
IFS= read -r read_probe < "$SIXB_CONTEXT_DIR/runtime/read-probe.out"
[ "$read_probe" = "c2l4Yi1ydW50aW1lLXByb2JlCg==" ] || exit 30
runtime_path="$(command -v bun || true)"
if [ -n "$runtime_path" ]; then
  runtime_name="bun"
  runtime_version="$("$runtime_path" --version)" || exit 29
else
  runtime_path="$(command -v node || true)"
fi
if [ -z "\${runtime_name:-}" ] && [ -n "$runtime_path" ]; then
  runtime_name="node"
  runtime_version="$("$runtime_path" --version)" || exit 29
fi
if [ -z "\${runtime_name:-}" ]; then
  exit 29
fi
cli_version="$(sixb --version)" || exit 31
printf '%s\t%s\t%s\n' "$runtime_name" "$runtime_version" "$cli_version"`
