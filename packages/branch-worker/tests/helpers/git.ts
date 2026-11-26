import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** A real git repository on disk, standing for the project's remote. */
export interface GitRepository {
  readonly path: string
  /** Creates `name` from the default branch's head. */
  branch(name: string): Promise<void>
  /** Commits a new file on `branch`, and returns the commit. */
  commit(branch: string, file: string): Promise<string>
  /** Merges `branch` into the default branch, as a merge commit. */
  merge(branch: string): Promise<void>
  deleteBranch(name: string): Promise<void>
  head(branch: string): Promise<string>
  remove(): Promise<void>
}

const ENV = {
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.com",
}

export async function gitRepository(): Promise<GitRepository> {
  const path = await mkdtemp(join(tmpdir(), "sixb-branch-origin-"))
  const git = (...args: string[]) => run(path, args)

  await git("init", "--quiet", "--initial-branch=main")
  await writeFile(join(path, "README.md"), "shop\n")
  await git("add", ".")
  await git("commit", "--quiet", "-m", "first")

  const repository: GitRepository = {
    path,
    branch: async (name) => {
      await git("branch", name, "main")
    },
    commit: async (branch, file) => {
      await git("checkout", "--quiet", branch)
      await writeFile(join(path, file), `${file}\n`)
      await git("add", ".")
      await git("commit", "--quiet", "-m", file)
      const head = await repository.head(branch)
      await git("checkout", "--quiet", "main")
      return head
    },
    merge: async (branch) => {
      await git("checkout", "--quiet", "main")
      await git("merge", "--quiet", "--no-ff", "-m", `merge ${branch}`, branch)
    },
    deleteBranch: async (name) => {
      await git("branch", "--quiet", "-D", name)
    },
    head: async (branch) => (await git("rev-parse", branch)).trim(),
    remove: () => rm(path, { recursive: true, force: true }),
  }
  return repository
}

/** One git command, awaited without blocking the test's process, with a bound. */
async function run(cwd: string, args: readonly string[]): Promise<string> {
  const git = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...ENV },
    stdout: "pipe",
    stderr: "pipe",
  })
  const kill = setTimeout(() => git.kill("SIGKILL"), 30_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(git.stdout).text(),
      new Response(git.stderr).text(),
      git.exited,
    ])
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
    return stdout
  } finally {
    clearTimeout(kill)
  }
}
