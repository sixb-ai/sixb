import { createHash } from "node:crypto"
import type { DeployAccessKey } from "@sixb/core/deploy"
import { type AuthorizedKey, parseAuthorizedKey, parsePublicKey } from "./keys"
import { shellQuote } from "./shell"
import type { RemoteShell } from "./transport"

interface KeysFile {
  readonly lines: readonly string[]
  readonly keys: readonly AuthorizedKey[]
  readonly hash: string
}

export async function listKeys(shell: RemoteShell): Promise<AuthorizedKey[]> {
  return [...(await readKeysFile(shell)).keys]
}

/** Authorizes a public key once, with `options` (such as `restrict`) in front of it. */
export async function addKey(
  shell: RemoteShell,
  text: string,
  options?: string
): Promise<AuthorizedKey> {
  const parsed = parsePublicKey(text)
  const key = options ? (parseAuthorizedKey(`${options} ${parsed.line}`) ?? parsed) : parsed
  const file = await readKeysFile(shell)
  if (file.keys.some((candidate) => candidate.fingerprint === key.fingerprint)) return key
  await rewrite(shell, [...file.lines, key.line], file.hash)
  return key
}

/** Removes the keys whose fingerprint or comment is `match`. Never removes the last one. */
export async function removeKeys(shell: RemoteShell, match: string): Promise<DeployAccessKey[]> {
  const removed = await removeKeysWhere(
    shell,
    (key) => key.fingerprint === match || key.comment === match
  )
  if (removed.length === 0) {
    throw new Error(`[SshTarget] No authorized key has the fingerprint or comment '${match}'.`)
  }
  return removed
}

/** Removes the keys `matches` picks, if any. Never removes the last one. */
export async function removeKeysWhere(
  shell: RemoteShell,
  matches: (key: AuthorizedKey) => boolean
): Promise<AuthorizedKey[]> {
  const file = await readKeysFile(shell)
  const removed = file.keys.filter(matches)
  if (removed.length === 0) return []
  if (removed.length === file.keys.length) {
    throw new Error(
      "[SshTarget] That would remove every key, and nobody could reach the deployment. " +
        "Add another key first."
    )
  }
  const gone = new Set(removed.map((key) => key.line))
  await rewrite(
    shell,
    file.lines.filter((line) => !gone.has(line.trim())),
    file.hash
  )
  return removed
}

async function readKeysFile(shell: RemoteShell): Promise<KeysFile> {
  const encoded: string[] = []
  await shell.run('(base64 < "$HOME/.ssh/authorized_keys" 2> /dev/null || true) | tr -d "\\n"', {
    onLine: (line, stream) => {
      if (stream === "stdout") encoded.push(line)
    },
  })
  const content = Buffer.from(encoded.join(""), "base64").toString("utf8")
  const lines = content.split("\n").filter((line, index, all) => line || index < all.length - 1)
  return {
    lines,
    keys: lines.flatMap((line) => parseAuthorizedKey(line) ?? []),
    hash: sha256(content),
  }
}

/**
 * Replaces `authorized_keys` through a rename, other lines untouched. Fails if the file changed
 * since it was read, so two people changing access at once cannot drop each other's key.
 */
async function rewrite(shell: RemoteShell, lines: readonly string[], readHash: string) {
  const content = `${lines.join("\n")}\n`
  await shell.run(
    [
      "set -euo pipefail",
      'keys="$HOME/.ssh/authorized_keys"',
      'mkdir -p -m 700 "$HOME/.ssh"',
      'current="$( (cat "$keys" 2> /dev/null || true) | sha256sum | cut -d" " -f1)"',
      `if [ "$current" != ${shellQuote(readHash)} ]; then`,
      '  echo "authorized_keys changed while this ran; run the command again." >&2',
      "  exit 1",
      "fi",
      `printf '%s' ${shellQuote(Buffer.from(content).toString("base64"))} | base64 -d > "$keys.new"`,
      'chmod 600 "$keys.new"',
      'mv "$keys.new" "$keys"',
    ].join("\n")
  )
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}
