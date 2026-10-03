import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RemoteShell } from "./transport"

/**
 * A new key pair for a CI job. It is made in a directory that is removed before this returns, so
 * the private key exists only in memory here and, afterwards, in the CI system's secrets.
 */
export async function generateCiKey(
  comment: string
): Promise<{ readonly privateKey: string; readonly publicKey: string }> {
  const dir = await mkdtemp(join(tmpdir(), "sixb-ci-key-"))
  try {
    const path = join(dir, "key")
    const child = Bun.spawn(
      ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", path],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      }
    )
    if ((await child.exited) !== 0) {
      const reason = (await new Response(child.stderr).text()).trim()
      throw new Error(`[SshTarget] ssh-keygen could not make a key for CI: ${reason}`)
    }
    return {
      privateKey: await readFile(path, "utf8"),
      publicKey: (await readFile(`${path}.pub`, "utf8")).trim(),
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * The server's host keys, read over a connection SSH has already checked against your own
 * `known_hosts`. CI trusts these instead of whatever answers at the address the first time.
 */
export async function readHostKeys(shell: RemoteShell): Promise<string[]> {
  const keys: string[] = []
  await shell.run("cat /etc/ssh/ssh_host_*_key.pub", {
    onLine: (line, stream) => {
      const [type, key] = line.trim().split(/\s+/)
      if (stream === "stdout" && type && key) keys.push(`${type} ${key}`)
    },
  })
  if (keys.length === 0) throw new Error("[SshTarget] Could not read the server's SSH host keys.")
  return keys
}

/** `known_hosts` lines for the host keys, under the name and port CI connects to. */
export function knownHostsLines(
  hostKeys: readonly string[],
  hostname: string,
  port: number
): string[] {
  const name = port === 22 ? hostname : `[${hostname}]:${port}`
  return hostKeys.map((key) => `${name} ${key}`)
}

/**
 * Shell lines that install the key on the CI runner, reading `SIXB_DEPLOY_SSH_KEY` and
 * `SIXB_DEPLOY_KNOWN_HOSTS` from the environment. `host` is what `sixb.deploy.ts` names, which may
 * be an alias from your SSH config; the runner gets the same alias.
 */
export function renderCiInstall(input: {
  readonly host: string
  readonly hostname: string
  readonly port: number
}): string[] {
  return [
    "install -d -m 700 ~/.ssh",
    "install -m 600 /dev/null ~/.ssh/sixb_deploy",
    `printf '%s\\n' "$SIXB_DEPLOY_SSH_KEY" > ~/.ssh/sixb_deploy`,
    `printf '%s\\n' "$SIXB_DEPLOY_KNOWN_HOSTS" > ~/.ssh/sixb_known_hosts`,
    "cat >> ~/.ssh/config <<'__SIXB_SSH_CONFIG__'",
    `Host ${input.host}`,
    `  HostName ${input.hostname}`,
    `  Port ${input.port}`,
    "  IdentityFile ~/.ssh/sixb_deploy",
    "  IdentitiesOnly yes",
    "  UserKnownHostsFile ~/.ssh/sixb_known_hosts",
    "  StrictHostKeyChecking yes",
    "__SIXB_SSH_CONFIG__",
  ]
}
