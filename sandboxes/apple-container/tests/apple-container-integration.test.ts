import { expect, test } from "bun:test"
import { posix } from "node:path"
import { AppleContainerSandbox } from "../src/apple-container-sandbox"
import { DEFAULT_APPLE_CONTAINER_IMAGE } from "../src/apple-container-sandbox-factory"
import { probeAppleContainer } from "../src/preflight"

const runIntegration = process.env.SIXB_APPLE_CONTAINER_INTEGRATION === "1" ? test : test.skip

runIntegration(
  "satisfies the agent-runtime command profile in a real Apple Container sandbox",
  async () => {
    const probe = probeAppleContainer(process.env.SIXB_APPLE_CONTAINER_BIN ?? "container")
    expect(probe.ok).toBe(true)

    const sandbox = await AppleContainerSandbox.create({
      cli: {
        bin: process.env.SIXB_APPLE_CONTAINER_BIN ?? "container",
        image: process.env.SIXB_APPLE_CONTAINER_IMAGE ?? DEFAULT_APPLE_CONTAINER_IMAGE,
        mounts: [],
        ports: [],
        dns: [],
        createArgs: [],
      },
      network: { mode: "all" },
    })
    try {
      const bashEnv = posix.join(sandbox.workingDirectory, "runtime", "bash-env")
      const fixture = posix.join(sandbox.workingDirectory, "runtime", "probe.txt")
      await sandbox.writeFiles([
        { path: bashEnv, contents: "export SIXB_BASH_ENV_READY=1\n" },
        { path: fixture, contents: "first\nsixb-runtime-probe\nthird\n" },
      ])
      const result = await sandbox.runCommand("bash", ["-lc", RUNTIME_COMMAND_PROBE], {
        env: { BASH_ENV: bashEnv, SIXB_RUNTIME_PROBE_FILE: fixture },
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toMatch(/^node:v?\d+\.\d+/)
    } finally {
      await sandbox.destroy()
    }
  },
  180_000
)

const RUNTIME_COMMAND_PROBE = `set -u
[ "\${SIXB_BASH_ENV_READY:-}" = "1" ] || exit 20
for command_name in realpath tail head base64; do
  command_path="$(command -v "$command_name" || true)"
  [ -n "$command_path" ] || exit 21
done
probe="$(tail -n "+2" -- "$SIXB_RUNTIME_PROBE_FILE" | head -n 1 | head -c 19 | base64)"
[ "$probe" = "c2l4Yi1ydW50aW1lLXByb2JlCg==" ] || exit 22
node_version="$(node --version)" || exit 23
node_major="\${node_version#v}"
node_major="\${node_major%%.*}"
[ "$node_major" -ge 22 ] || exit 23
printf 'node:%s\n' "$node_version"`
