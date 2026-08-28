import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { SandboxFactory } from "@sixb/core"

/** Provider-specific smoke for the command behavior required by `sixb-agent-runtime/v1`. */
export function runLocalAgentRuntimeConformance(
  name: string,
  createFactory: () => SandboxFactory
): void {
  describe(`${name} agent runtime`, () => {
    test("supports Bash bootstrap, bounded reads, and the portable CLI runtime", async () => {
      const sandbox = await createFactory().create()
      try {
        const bashEnv = join(sandbox.workingDirectory, "runtime", "bash-env")
        const fixture = join(sandbox.workingDirectory, "runtime", "probe.txt")
        await sandbox.writeFiles([
          { path: bashEnv, contents: "export SIXB_BASH_ENV_READY=1\n" },
          { path: fixture, contents: "first\nsixb-runtime-probe\nthird\n" },
        ])

        const result = await sandbox.runCommand("bash", ["-lc", RUNTIME_COMMAND_PROBE], {
          env: { BASH_ENV: bashEnv, SIXB_RUNTIME_PROBE_FILE: fixture },
        })

        expect(result.exitCode).toBe(0)
        expect(result.stdout.trim()).toMatch(/^(bun|node):v?\d+\.\d+/)
      } finally {
        await sandbox.destroy()
      }
    })
  })
}

const RUNTIME_COMMAND_PROBE = `set -u
[ "\${SIXB_BASH_ENV_READY:-}" = "1" ] || exit 20
for command_name in realpath tail head base64; do
  command_path="$(command -v "$command_name" || true)"
  [ -n "$command_path" ] || exit 21
done
probe="$(tail -n "+2" -- "$SIXB_RUNTIME_PROBE_FILE" | head -n 1 | head -c 19 | base64)"
[ "$probe" = "c2l4Yi1ydW50aW1lLXByb2JlCg==" ] || exit 22
runtime_path="$(command -v bun || true)"
if [ -n "$runtime_path" ]; then
  runtime_name="bun"
else
  runtime_path="$(command -v node || true)"
  runtime_name="node"
fi
[ -n "$runtime_path" ] || exit 23
runtime_version="$("$runtime_path" --version)" || exit 23
normalized_version="\${runtime_version#v}"
runtime_major="\${normalized_version%%.*}"
runtime_rest="\${normalized_version#*.}"
runtime_minor="\${runtime_rest%%.*}"
if [ "$runtime_name" = "bun" ]; then
  [ "$runtime_major" -gt 1 ] || { [ "$runtime_major" -eq 1 ] && [ "$runtime_minor" -ge 3 ]; } || exit 23
else
  [ "$runtime_major" -ge 22 ] || exit 23
fi
printf '%s:%s\n' "$runtime_name" "$runtime_version"`
