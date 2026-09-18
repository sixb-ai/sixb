import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

export interface WorkspaceIdentity {
  readonly path: string
  readonly device: string
  readonly inode: string
}
export interface StagedFile {
  readonly path: string
  readonly mode?: number
}

/** A policy rejection is recoverable only after staging cleanup and thaw both succeed. */
export class FilePolicyError extends Error {}

export function workloadGroup(root: string): string {
  return `/sys/fs/cgroup/${path.basename(root)}`
}

export function workspaceIdentity(directory: string): WorkspaceIdentity {
  const resolved = fs.realpathSync(directory)
  if (resolved !== directory) throw new FilePolicyError("workspace-changed")
  const stat = fs.lstatSync(resolved, { bigint: true })
  if (!stat.isDirectory()) throw new FilePolicyError("workspace-changed")
  return { path: resolved, device: String(stat.dev), inode: String(stat.ino) }
}

function readWorkspace(root: string): WorkspaceIdentity {
  const value: unknown = JSON.parse(fs.readFileSync(path.join(root, "workspace.json"), "utf8"))
  if (
    !value ||
    typeof value !== "object" ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    !("device" in value) ||
    typeof value.device !== "string" ||
    !("inode" in value) ||
    typeof value.inode !== "string"
  ) {
    throw new Error("invalid workspace identity")
  }
  return { path: value.path, device: value.device, inode: value.inode }
}

export function parseManifest(text: string): readonly StagedFile[] {
  const value: unknown = JSON.parse(text)
  if (!Array.isArray(value)) throw new Error("invalid file manifest")
  return value.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("path" in entry) ||
      typeof entry.path !== "string" ||
      ("mode" in entry &&
        (typeof entry.mode !== "number" ||
          !Number.isInteger(entry.mode) ||
          entry.mode < 0 ||
          entry.mode > 0o7777))
    ) {
      throw new Error("invalid file entry")
    }
    const mode = "mode" in entry && typeof entry.mode === "number" ? entry.mode : undefined
    return { path: entry.path, mode }
  })
}

function lstatIfPresent(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

/** Caller must freeze all untrusted workload processes for the entire operation. */
export function materializeBatch(
  workspace: WorkspaceIdentity,
  files: readonly StagedFile[],
  staging: string,
  owner: { readonly uid: number; readonly gid: number }
): void {
  const current = workspaceIdentity(workspace.path)
  if (
    current.path !== workspace.path ||
    current.device !== workspace.device ||
    current.inode !== workspace.inode
  ) {
    throw new FilePolicyError("workspace-changed")
  }
  // Validate every lexical path before any workspace mutation. Symlinks are never followed,
  // even when they currently point inside the workspace. Only regular files are replaced.
  const paths = files.map((file) => {
    if (
      !file.path ||
      file.path.includes("\0") ||
      path.isAbsolute(file.path) ||
      file.path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new FilePolicyError("unsafe-path")
    }
    return file.path.split("/")
  })
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!
    const parts = paths[index]!
    let parent = workspace.path
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part)
      const stat = lstatIfPresent(parent)
      if (stat) {
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FilePolicyError("unsafe-path")
      } else {
        fs.mkdirSync(parent, { mode: 0o700 })
        fs.chownSync(parent, owner.uid, owner.gid)
      }
    }
    const target = path.join(parent, parts.at(-1)!)
    const existing = lstatIfPresent(target)
    if (existing && (!existing.isFile() || existing.isSymbolicLink()))
      throw new FilePolicyError("unsafe-path")
    const source = path.join(staging, String(index))
    if (!fs.lstatSync(source).isFile()) throw new Error("invalid staged file")
    const temporary = path.join(parent, `.sixb-write-${randomUUID()}`)
    try {
      // Replace the directory entry instead of truncating the existing inode: an existing
      // hard link must not cause writes or chmod/chown outside the workspace.
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL)
      const fd = fs.openSync(temporary, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try {
        fs.fchownSync(fd, owner.uid, owner.gid)
        fs.fchmodSync(fd, file.mode ?? (existing ? existing.mode & 0o7777 : 0o644))
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(temporary, target)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }
}

export async function setWorkloadsFrozen(root: string, frozen: boolean): Promise<void> {
  const group = workloadGroup(root)
  fs.writeFileSync(`${group}/cgroup.freeze`, frozen ? "1" : "0")
  const deadline = performance.now() + 10_000
  const expected = frozen ? /^frozen 1$/m : /^frozen 0$/m
  while (!expected.test(fs.readFileSync(`${group}/cgroup.events`, "utf8"))) {
    if (performance.now() >= deadline) throw new Error("workload freeze transition timed out")
    await delay(10)
  }
}

export async function publishStagedFiles(root: string, id: string): Promise<unknown> {
  const staging = path.join(root, `files-${id}`)
  const lock = path.join(root, "files.lock")
  // Host calls are serialized. Refuse overlapping or uncertain commits instead of
  // allowing one request to thaw workloads while another request is still writing.
  fs.mkdirSync(lock, { mode: 0o700 })
  try {
    await setWorkloadsFrozen(root, true)
    try {
      const files = parseManifest(fs.readFileSync(path.join(staging, "manifest.json"), "utf8"))
      materializeBatch(readWorkspace(root), files, staging, { uid: 65534, gid: 65534 })
      return { state: "files-written" }
    } catch (error) {
      if (error instanceof FilePolicyError)
        return { state: "files-rejected", reason: error.message }
      throw error
    }
  } finally {
    // Do not report success/rejection until both cleanup and thaw are confirmed.
    try {
      fs.rmSync(staging, { recursive: true, force: true })
    } finally {
      await setWorkloadsFrozen(root, false)
      fs.rmdirSync(lock)
    }
  }
}
