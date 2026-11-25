import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { probeSmolvm } from "../src/preflight"
import { SmolvmSandbox } from "../src/smolvm-sandbox"

/**
 * Real-VM round trip against an installed `smolvm`. Skips cleanly (describe.skip)
 * when the binary or host virtualization is unavailable, like the local backend's
 * *-integration.test.ts.
 *
 * Uses a BARE machine (no image) on purpose: it boots fully offline from the
 * built-in busybox rootfs, so the test needs no Docker and no prebuilt archive
 * in CI. It validates the real lifecycle, in-guest file materialization via
 * writeFiles, --workdir, --env, exit codes, and stream separation end to end.
 * The rootfs ships busybox `sh` (not bash), so commands use `sh`.
 *
 * The cases share one VM: each boot costs most of a second and none of them changes what the
 * others observe. The runaway command runs last because its guest process outlives the killed
 * exec session until destroy reaps the VM.
 */
const available = probeSmolvm("smolvm").ok
const guard = available ? describe : describe.skip

guard("SmolvmSandbox (real bare VM)", () => {
  let sandbox: SmolvmSandbox

  // Bare machine: no image => offline. Generous timeout: first boot is slow.
  beforeAll(async () => {
    sandbox = await SmolvmSandbox.create({
      cli: { bin: "smolvm" },
      timeout: 120_000,
      env: { SIXB_RUN_ID: "run-xyz" },
    })
  }, 180_000)

  afterAll(async () => {
    await sandbox?.destroy()
  }, 180_000)

  test("separates stdout/stderr and reports the real exit code", async () => {
    const result = await sandbox.runCommand("sh", ["-lc", "echo out; echo err 1>&2; exit 3"])
    expect(result.stdout.trim()).toBe("out")
    expect(result.stderr.trim()).toBe("err")
    expect(result.exitCode).toBe(3)
  }, 180_000)

  test("guest reads files materialized in-guest via writeFiles", async () => {
    const runContextPath = join(sandbox.workingDirectory, ".sixb", "agent", "context", "run.json")
    await sandbox.writeFiles([{ path: runContextPath, contents: '{"ok":true}' }])

    const result = await sandbox.runCommand("sh", ["-lc", "cat .sixb/agent/context/run.json"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"ok":true')
  }, 180_000)

  // The fake smolvm hands the script its input with or without `--interactive`: only a real guest
  // proves smolvm forwards it. Regression check: drop `interactive` from writeFiles; the guest
  // script then reads no input and the write fails.
  test("writes a large file and many files in one call", async () => {
    const large = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, index) => (index * 7919) % 256)
    const many = Array.from({ length: 200 }, (_, index) => ({
      path: `many/${index}.txt`,
      contents: `${index}\n`,
    }))
    await sandbox.writeFiles([{ path: "large.bin", contents: large, mode: 0o640 }, ...many])

    const result = await sandbox.runCommand("sh", [
      "-c",
      "sha256sum large.bin; stat -c %a large.bin; ls many | wc -l",
    ])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.split(/\s+/).filter(Boolean)).toEqual([
      createHash("sha256").update(large).digest("hex"),
      "large.bin",
      "640",
      "200",
    ])
  }, 180_000)

  test("runs in workingDirectory and injects env vars", async () => {
    // The bare rootfs links /workspace to /storage/workspace, so compare physical paths.
    const pwd = await sandbox.runCommand("sh", ["-lc", "pwd -P"])
    const resolved = await sandbox.runCommand("realpath", [sandbox.workingDirectory])
    expect(pwd.stdout.trim()).toBe(resolved.stdout.trim())

    const env = await sandbox.runCommand("sh", ["-lc", 'echo "$SIXB_RUN_ID"'])
    expect(env.stdout.trim()).toBe("run-xyz")
  }, 180_000)

  test("times out a runaway command", async () => {
    const result = await sandbox.runCommand("sh", ["-lc", "sleep 30"], { timeout: 500 })
    expect(result.timedOut).toBe(true)
  }, 180_000)
})

// A hosted branch's runtime: a server the VM keeps running, reached on one of its ports.
// Removal proof: signal the recorded process alone in `start`'s kill, not its group: the loop
// it started serves on.
guard("SmolvmSandbox serving a port (real bare VM)", () => {
  const port = 20_000 + Math.floor(Math.random() * 9_000)
  let sandbox: SmolvmSandbox

  beforeAll(async () => {
    sandbox = await SmolvmSandbox.create({ cli: { bin: "smolvm" }, ports: [port] })
  }, 180_000)

  afterAll(async () => {
    await sandbox?.destroy()
  }, 180_000)

  test("serves a started command on the host's loopback, until it is killed", async () => {
    const server = await sandbox.start(
      "sh",
      [
        "-c",
        'while true; do printf "HTTP/1.0 200 OK\\r\\nContent-Length: 6\\r\\n\\r\\n$GREETING" | nc -l -p "$PORT"; done',
      ],
      { env: { GREETING: "served", PORT: String(port) } }
    )

    // The VM's server comes up on its own time: poll it, bounded.
    let body = ""
    for (let attempt = 0; attempt < 100 && body !== "served"; attempt += 1) {
      body = await fetch(sandbox.url(port), { signal: AbortSignal.timeout(1_000) })
        .then((response) => response.text())
        .catch(() => "")
      if (body !== "served") await Bun.sleep(100)
    }
    expect(body).toBe("served")
    expect(() => sandbox.url(port + 1)).toThrow("not published")

    await server.kill()
    await server.exited
    const after = await fetch(sandbox.url(port), { signal: AbortSignal.timeout(1_000) })
      .then((response) => response.text())
      .catch(() => "")
    expect(after).toBe("")
  }, 180_000)
})

/** This host's address on its network, which a VM reaches; none on a host with no network. */
function hostAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address
    }
  }
  return undefined
}

// A hosted branch's sandbox reaches what its policy names, and not the cloud's metadata endpoint
// or the rest of a private network. Removal proof: return `["--net"]` for a restricted policy in
// `buildNetworkFlags`: every address answers.
const lan = hostAddress()
;(available && lan ? describe : describe.skip)(
  "SmolvmSandbox restricted network (real bare VM)",
  () => {
    const port = 20_000 + Math.floor(Math.random() * 9_000)
    let sandbox: SmolvmSandbox
    let server: ReturnType<typeof Bun.serve>

    beforeAll(async () => {
      server = Bun.serve({ hostname: "0.0.0.0", port, fetch: () => new Response("allowed") })
      sandbox = await SmolvmSandbox.create({
        cli: { bin: "smolvm" },
        network: { mode: "restricted", allow: [{ name: "host", origin: `http://${lan}:${port}` }] },
      })
    }, 180_000)

    afterAll(async () => {
      await sandbox?.destroy()
      await server?.stop(true)
    }, 180_000)

    test("reaches what it allows, and no metadata endpoint or other private address", async () => {
      const reach = async (host: string, target: number) => {
        const result = await sandbox.runCommand("sh", [
          "-c",
          `printf 'GET / HTTP/1.0\\r\\n\\r\\n' | nc -w 3 "$1" "$2"`,
          "sh",
          host,
          String(target),
        ])
        // nc exits 0 once it connected, whatever the host answers.
        return result.exitCode === 0
      }

      expect(await reach(lan!, port)).toBe(true)
      expect(await reach("169.254.169.254", 80)).toBe(false)
      expect(await reach("10.255.255.1", 80)).toBe(false)
      // A host the open network reaches, on a machine online: what proves the policy is enforced.
      expect(await reach("1.1.1.1", 80)).toBe(false)
    }, 180_000)
  }
)
