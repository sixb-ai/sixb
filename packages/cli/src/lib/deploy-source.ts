import { userInfo } from "node:os"
import { dirname, join, posix, resolve } from "node:path"
import type { DeploySource, DeploySourceArchive } from "@sixb/core/deploy"
import { SixbCliError } from "./errors"

export interface PackedSource extends DeploySource {
  /** Whether the working tree has changes the deployed commit does not. */
  readonly dirty: boolean
}

/**
 * The committed files at `ref`, with every submodule at the commit its parent records. Nothing
 * uncommitted or ignored is sent, so what runs is always a commit anyone can look up.
 */
export async function packSource(projectDir: string, ref = "HEAD"): Promise<PackedSource> {
  const root = await git(projectDir, ["rev-parse", "--show-toplevel"]).catch(() => {
    throw new SixbCliError(`[SixbDeploy] ${projectDir} is not in a git repository.`, {
      remediation: "sixb deploy sends a commit. Commit the project to a git repository first.",
    })
  })
  const commit = await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(
    () => {
      throw new SixbCliError(`[SixbDeploy] '${ref}' is not a commit in this repository.`, {
        remediation: "Fetch it first, or pass a branch, tag, or commit that exists locally.",
      })
    }
  )
  // Asked of git rather than computed from paths, which a symlinked directory would skew.
  const projectPath =
    (await git(projectDir, ["rev-parse", "--show-prefix"])).replace(/\/$/, "") || "."

  if (!(await isFile(root, commit, posix.join(projectPath, "package.json")))) {
    throw new SixbCliError(
      `[SixbDeploy] Commit ${commit.slice(0, 12)} has no ${posix.join(projectPath, "package.json")}.`,
      { remediation: "Commit the project before deploying it." }
    )
  }

  return {
    commit,
    ref,
    projectPath,
    dirty: (await git(root, ["status", "--porcelain"])) !== "",
    archives: [
      { path: ".", open: () => archive(root, commit) },
      ...(await submoduleArchives(root, commit, "")),
    ],
  }
}

/**
 * The Bun version the project pins with `packageManager` (`"bun@1.4.2"`) in its `package.json` or
 * the nearest one above it, up to the repository root; else the Bun running this CLI. Read from the
 * deployed commit when there is one, and from the files on disk for a dry run.
 */
export async function resolveBunVersion(
  projectDir: string,
  source?: Pick<DeploySource, "commit" | "projectPath">
): Promise<string> {
  const root = source ? await git(projectDir, ["rev-parse", "--show-toplevel"]) : null
  let dir = source ? source.projectPath : resolve(projectDir)
  for (;;) {
    const manifest = await readPackageJson(dir, root && source ? source.commit : null)
    const pinned =
      typeof manifest?.packageManager === "string"
        ? manifest.packageManager.match(/^bun@(\d+\.\d+\.\d+)/)?.[1]
        : undefined
    if (pinned) return pinned

    const atTop = source
      ? dir === "."
      : (await Bun.file(join(dir, ".git")).exists()) || dirname(dir) === dir
    if (atTop) return Bun.version
    dir = source ? posix.dirname(dir) : dirname(dir)
  }

  async function readPackageJson(
    at: string,
    commit: string | null
  ): Promise<{ readonly packageManager?: unknown } | null> {
    const text =
      commit && root
        ? await git(root, ["show", `${commit}:${posix.join(at, "package.json")}`]).catch(() => null)
        : await Bun.file(join(at, "package.json"))
            .text()
            .catch(() => null)
    if (text === null) return null
    try {
      return JSON.parse(text) as { readonly packageManager?: unknown }
    } catch {
      return null
    }
  }
}

/** Who deploys, recorded with the release. */
export async function deployer(projectDir: string): Promise<string> {
  if (process.env.GITHUB_ACTIONS && process.env.GITHUB_ACTOR) {
    return `${process.env.GITHUB_ACTOR} (GitHub Actions)`
  }
  const email = await git(projectDir, ["config", "user.email"]).catch(() => "")
  return email || userInfo().username
}

async function submoduleArchives(
  repo: string,
  commit: string,
  prefix: string
): Promise<DeploySourceArchive[]> {
  const entries = (await git(repo, ["ls-tree", "-r", "-z", commit])).split("\0").filter(Boolean)
  const archives: DeploySourceArchive[] = []

  for (const entry of entries) {
    const [meta, path] = entry.split("\t")
    const [mode, , submoduleCommit] = meta?.split(" ") ?? []
    if (mode !== "160000" || !path || !submoduleCommit) continue

    const submodule = posix.join(repo, path)
    const at = posix.join(prefix, path)
    const checkedOut = await git(submodule, ["cat-file", "-e", `${submoduleCommit}^{commit}`])
      .then(() => true)
      .catch(() => false)
    if (!checkedOut) {
      throw new SixbCliError(
        `[SixbDeploy] Submodule ${at} is not checked out at ${submoduleCommit.slice(0, 12)}.`,
        { remediation: "Run `git submodule update --init --recursive` and deploy again." }
      )
    }
    archives.push({ path: at, open: () => archive(submodule, submoduleCommit) })
    archives.push(...(await submoduleArchives(submodule, submoduleCommit, at)))
  }
  return archives
}

/** `git archive` as a stream that fails if git does. */
function archive(repo: string, commit: string): ReadableStream<Uint8Array> {
  const child = Bun.spawn(["git", "archive", "--format=tar", commit], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = child.stdout.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (!done) {
        controller.enqueue(value)
        return
      }
      const exitCode = await child.exited
      if (exitCode === 0) controller.close()
      else {
        const stderr = await new Response(child.stderr).text()
        controller.error(new Error(`[SixbDeploy] git archive failed in ${repo}: ${stderr.trim()}`))
      }
    },
    cancel() {
      child.kill()
    },
  })
}

async function isFile(root: string, commit: string, path: string): Promise<boolean> {
  return git(root, ["cat-file", "-e", `${commit}:${path}`])
    .then(() => true)
    .catch(() => false)
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args.join(" ")} failed`)
  return stdout.trim()
}
