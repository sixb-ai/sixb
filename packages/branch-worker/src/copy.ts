import { open as openFile, rm, writeFile } from "node:fs/promises"
import { join, posix } from "node:path"
import { resolveAuthorizationContext, type Sandbox, type SixbHostView } from "@sixb/core"
import {
  BRANCH_COPIES_DIRECTORY,
  copyForBranch,
  HOSTED_BRANCH_COPY,
  prepareBranchData,
  readBranchCopy,
  takeBranchCopySlot,
} from "@sixb/core/internal/branches"
import type { BranchRecord } from "@sixb/core/storage"
import { stagingDirectory } from "./staging"

/** The copy reaches the sandbox in parts of this size, so no more of it is ever in memory. */
const COPY_PART_BYTES = 32 * 1024 * 1024

/** Where a hosted branch's files go in its sandbox, and what its runtime starts with. */
export interface BranchSandboxFiles {
  readonly sandbox: Sandbox
  /** The project's folder in the sandbox's checkout. */
  readonly projectDirectory: string
  readonly signal: AbortSignal
  /** Throws unless the worker still holds the branch: called before its data is dropped. */
  readonly fence: () => Promise<void>
}

/**
 * A new copy of production for the branch, as `sixb dev --from production` takes one: production
 * makes the branch's schema anew, so what it wrote goes, and copies what its creator reads now
 * (`copyForBranch`, under the same limit as a laptop's copy). The copy reaches the sandbox whole,
 * where a laptop's supervisor spools one, before production keeps its lake slice as received. The
 * branch's runtime loads it when it starts, as its role, and its front says what it loaded.
 *
 * The one call open and refresh make: how production takes the copy may change behind it. Null
 * when there is no place for the copy yet: its creator copies elsewhere, or the project's places
 * are taken. The branch waits, and its next tick asks again. Otherwise the lake slice production
 * now keeps for it, which the branch releases with its copy, and whether production capped its
 * role's temporary files.
 */
export async function copyIntoSandbox(
  host: SixbHostView,
  branch: BranchRecord,
  files: BranchSandboxFiles,
  production: { readonly apiUrl: string }
): Promise<{ readonly lakeSliceId: string | null; readonly tempFileLimit: boolean } | null> {
  const person = await creatorContext(host, branch.createdBy)
  const slot = takeBranchCopySlot(host.id, branch.createdBy)
  if ("refused" in slot) return null

  const staging = await stagingDirectory()
  try {
    await files.fence()
    const { tempFileLimit } = await prepareBranchData(host, branch)

    // Whole on disk first: production's consistent read never waits on the sandbox's upload.
    const staged = join(staging, "copy")
    const file = await openFile(staged, "w", 0o600)
    try {
      for await (const part of copyForBranch(host, {
        person,
        branch: branch.name,
        requestId: `branch_copy_${branch.namespace}_${Date.now()}`,
        directory: staging,
      })) {
        await file.write(part)
      }
    } finally {
      await file.close()
    }
    const lake = await lakeOf(staged)

    await sendCopy(files, staged)
    await writeFile(
      join(staging, "pending"),
      JSON.stringify({ gitBranch: branch.name, apiUrl: production.apiUrl, profile: "production" })
    )
    await sendFile(files, join(staging, "pending"), `${copyPath(files)}.json`)

    // Whole in the sandbox: production keeps the copy's slice, as a laptop's confirmation does.
    if (lake && host.storage.lakeSlices) {
      await host.storage.lakeSlices.markReceived({
        projectId: host.id,
        id: lake.sliceId,
        at: new Date(),
      })
    }
    return { lakeSliceId: lake?.sliceId ?? null, tempFileLimit }
  } finally {
    slot.release()
    await rm(staging, { recursive: true, force: true })
  }
}

/** Where the branch's runtime finds its copy: `.sixb/branches/hosted.copy` in the project. */
export function copyPath(files: Pick<BranchSandboxFiles, "projectDirectory">): string {
  return posix.join(files.projectDirectory, BRANCH_COPIES_DIRECTORY, `${HOSTED_BRANCH_COPY}.copy`)
}

/**
 * The branch's creator as production knows them now: an active member, in their groups. A
 * branch takes no new copy for someone who left, nor more than they read.
 */
async function creatorContext(host: SixbHostView, userId: string) {
  const auth = host.storage.auth
  if (!auth) {
    throw new Error("[SixbBranchWorker] A branch copies what its creator reads, from storage.auth.")
  }

  const user = await auth.users.getById({ projectId: host.id, id: userId })
  if (!user || user.status !== "active") {
    throw new Error(
      `[SixbBranchWorker] '${userId}' is no longer an active member: their branch takes no new copy.`
    )
  }
  const memberships = await auth.groupMemberships.listForUser({ projectId: host.id, userId })
  return resolveAuthorizationContext({
    principal: { type: "user", id: userId },
    groupIds: memberships.map((membership) => membership.groupId),
    roles: host.definitions.security.listResolvedRoles(),
  })
}

/** The lake part of a staged copy, read through to its end: a copy cut short throws. */
async function lakeOf(path: string) {
  const copy = readBranchCopy(Bun.file(path).stream() as unknown as AsyncIterable<Uint8Array>)
  for await (const _ of copy.snapshot) {
    // The snapshot is the branch's to load: only what follows it is read here.
  }
  return (await copy.rest())?.lake ?? null
}

/**
 * The copy into the sandbox, its owner's only from its first byte: in parts, joined in place, and
 * named for the runtime only once whole.
 */
async function sendCopy(files: BranchSandboxFiles, path: string): Promise<void> {
  const target = copyPath(files)
  const parts = `${target}.parts`
  await run(files, ["sh", "-c", `umask 077; rm -rf "$0"; mkdir -p "$0"`, parts])
  await run(files, ["chmod", "700", posix.dirname(target)])

  const file = await openFile(path)
  let count = 0
  try {
    const buffer = new Uint8Array(COPY_PART_BYTES)
    for (; ; count += 1) {
      const { bytesRead } = await file.read(buffer, 0, COPY_PART_BYTES, null)
      if (bytesRead === 0 && count > 0) break

      await files.sandbox.writeFiles([
        {
          path: posix.join(parts, String(count).padStart(6, "0")),
          contents: buffer.slice(0, bytesRead),
        },
      ])
      if (bytesRead < COPY_PART_BYTES) {
        count += 1
        break
      }
    }
  } finally {
    await file.close()
  }

  await run(files, [
    "sh",
    "-c",
    'umask 077; cat "$0"/* > "$1.partial" && mv "$1.partial" "$1" && rm -rf "$0"',
    parts,
    target,
  ])
}

/** A small file into the sandbox, its owner's only. */
async function sendFile(files: BranchSandboxFiles, from: string, to: string): Promise<void> {
  await files.sandbox.writeFiles([
    { path: to, contents: new Uint8Array(await Bun.file(from).arrayBuffer()) },
  ])
  await run(files, ["chmod", "600", to])
}

async function run(files: BranchSandboxFiles, argv: readonly [string, ...string[]]) {
  const [command, ...args] = argv
  const result = await files.sandbox.runCommand(command, args, {
    cwd: files.projectDirectory,
    timeout: 10 * 60_000,
    signal: files.signal,
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `[SixbBranchWorker] The branch's copy could not be written: ${result.stderr.trim() || `exit ${result.exitCode}`}`
    )
  }
}
