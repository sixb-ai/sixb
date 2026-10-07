import { dirname, join, posix, relative } from "node:path"
import { SixbCliError } from "./errors"

/** The GitHub environment that holds the deploy secrets and gates the deploy job. */
export const CI_ENVIRONMENT = "production"

/** The secret a private submodule's checkout reads. */
export const SUBMODULE_TOKEN_SECRET = "SIXB_GITHUB_TOKEN"

/** Actions pinned by commit, so a moved tag cannot change what runs with the deploy key. */
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1"
const SETUP_BUN = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0"

export interface GitHubRepo {
  /** `owner/name`. */
  readonly name: string
  readonly defaultBranch: string
}

export interface Submodule {
  readonly path: string
  readonly url: string
  /** `owner/name` when the submodule lives on GitHub. */
  readonly repo: string | null
}

export interface WorkflowInput {
  /** The deployment's name. */
  readonly name: string
  readonly branch: string
  /** The project's directory relative to the repository root, `"."` at the root. */
  readonly projectPath: string
  /** The `package.json` that pins Bun, relative to the repository root. */
  readonly bunVersionFile: string | null
  /** GitHub secret names, by the environment variable the install lines read. */
  readonly secrets: Readonly<Record<string, string>>
  readonly install: readonly string[]
  readonly submodules: "none" | "public" | "private"
}

/** A GitHub Actions workflow that deploys on every push to `branch`. */
export function renderWorkflow(input: WorkflowInput): string {
  const workingDirectory =
    input.projectPath === "." ? [] : [`        working-directory: ${input.projectPath}`]
  const checkoutWith = [
    "          persist-credentials: false",
    ...(input.submodules === "none" ? [] : ["          submodules: recursive"]),
    ...(input.submodules === "private"
      ? [`          token: \${{ secrets.${SUBMODULE_TOKEN_SECRET} }}`]
      : []),
  ]
  const tokenCheck =
    input.submodules === "private"
      ? [
          "      - name: Check the token for private submodules",
          "        env:",
          `          HAS_TOKEN: \${{ secrets.${SUBMODULE_TOKEN_SECRET} != '' }}`,
          "        run: |",
          '          if [ "$HAS_TOKEN" != true ]; then',
          `            echo "::error::Set the ${SUBMODULE_TOKEN_SECRET} secret in the ${CI_ENVIRONMENT} environment to a token that can read this repository's private submodules."`,
          "            exit 1",
          "          fi",
        ]
      : []

  return [
    `# Written by \`sixb deploy ci\`. Run it again to rotate the deploy key.`,
    `name: Deploy ${input.name}`,
    "",
    "on:",
    "  push:",
    `    branches: [${JSON.stringify(input.branch)}]`,
    "  workflow_dispatch:",
    "",
    "permissions:",
    "  contents: read",
    "",
    "# One deploy at a time; a push during a deploy waits for it instead of cancelling it.",
    "concurrency:",
    `  group: sixb-deploy-${input.name}`,
    "  cancel-in-progress: false",
    "",
    "jobs:",
    "  deploy:",
    "    runs-on: ubuntu-latest",
    `    environment: ${CI_ENVIRONMENT}`,
    "    timeout-minutes: 30",
    "    steps:",
    ...tokenCheck,
    `      - uses: ${CHECKOUT}`,
    "        with:",
    ...checkoutWith,
    `      - uses: ${SETUP_BUN}`,
    ...(input.bunVersionFile
      ? ["        with:", `          bun-version-file: ${input.bunVersionFile}`]
      : []),
    "      - name: Install dependencies",
    "        run: bun install --frozen-lockfile",
    ...workingDirectory,
    "      - name: Install the deploy key",
    "        env:",
    ...Object.entries(input.secrets).map(
      ([variable, secret]) => `          ${variable}: \${{ secrets.${secret} }}`
    ),
    "        run: |",
    ...input.install.map((line) => `          ${line}`),
    "      - name: Deploy",
    "        run: bunx sixb deploy",
    ...workingDirectory,
    "",
  ].join("\n")
}

/** Where the workflow for a deployment lives, relative to the repository root. */
export function workflowPath(name: string): string {
  return `.github/workflows/deploy-${name}.yml`
}

/** The GitHub secret for one of a deployment's variables; a repository may deploy several. */
export function secretName(deployment: string, variable: string): string {
  return `${variable}_${deployment.toUpperCase().replaceAll("-", "_")}`
}

/** The `package.json` that pins Bun for the project, relative to the repository root. */
export async function bunVersionFile(projectDir: string, repoRoot: string): Promise<string | null> {
  for (let dir = projectDir; ; dir = dirname(dir)) {
    const manifest = await Bun.file(join(dir, "package.json"))
      .json()
      .catch(() => null)
    if (
      typeof manifest?.packageManager === "string" &&
      manifest.packageManager.startsWith("bun@")
    ) {
      return relative(repoRoot, join(dir, "package.json")).split("\\").join("/")
    }
    if (dir === repoRoot || dirname(dir) === dir) return null
  }
}

/** The submodules `.gitmodules` lists, with the GitHub repository behind each. */
export async function readSubmodules(repoRoot: string, repo: GitHubRepo): Promise<Submodule[]> {
  const output = await run(
    ["git", "config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.(path|url)$"],
    { cwd: repoRoot }
  ).catch(() => "")
  const byName = new Map<string, { path?: string; url?: string }>()
  for (const line of output.split("\n")) {
    const match = line.match(/^submodule\.(.+)\.(path|url) (.+)$/)
    if (!match?.[1] || !match[2] || !match[3]) continue
    const entry = byName.get(match[1]) ?? {}
    entry[match[2] as "path" | "url"] = match[3]
    byName.set(match[1], entry)
  }
  return [...byName.values()].flatMap(({ path, url }) =>
    path && url ? [{ path, url, repo: githubRepoOf(url, repo.name) }] : []
  )
}

/** `owner/name` for a GitHub remote URL, resolving a relative one against `parent`. */
export function githubRepoOf(url: string, parent: string): string | null {
  if (url.startsWith("./") || url.startsWith("../")) {
    const resolved = posix.normalize(posix.join(parent, url))
    return resolved.replace(/\.git$/, "").split("/").length === 2
      ? resolved.replace(/\.git$/, "")
      : null
  }
  const match = url.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/
  )
  return match?.[1] ?? null
}

export async function currentRepo(cwd: string): Promise<GitHubRepo> {
  const output = await gh(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], { cwd })
  const parsed = JSON.parse(output) as {
    nameWithOwner: string
    defaultBranchRef: { name: string } | null
  }
  return { name: parsed.nameWithOwner, defaultBranch: parsed.defaultBranchRef?.name ?? "main" }
}

/** Whether CI's own token cannot read `repo`. A repository this login cannot see counts. */
export async function isPrivate(repo: string): Promise<boolean> {
  const output = await gh(["api", `repos/${repo}`, "--jq", ".private"]).catch(() => "true")
  return output.trim() !== "false"
}

/** Creates the environment when it is missing. An existing one keeps its protection rules. */
export async function ensureEnvironment(repo: GitHubRepo): Promise<void> {
  const path = `repos/${repo.name}/environments/${CI_ENVIRONMENT}`
  const exists = await gh(["api", path, "--silent"]).then(
    () => true,
    () => false
  )
  if (!exists) await gh(["api", "--method", "PUT", path, "--silent"])
}

export async function setSecret(repo: GitHubRepo, name: string, value: string): Promise<void> {
  await gh(["secret", "set", name, "--env", CI_ENVIRONMENT, "--repo", repo.name], {
    input: value,
  })
}

/** Whether the environment or the repository has the secret. */
export async function hasSecret(repo: GitHubRepo, name: string): Promise<boolean> {
  for (const scope of [["--env", CI_ENVIRONMENT], []]) {
    const list = await gh(["secret", "list", ...scope, "--repo", repo.name, "--json", "name"])
    if ((JSON.parse(list) as { name: string }[]).some((secret) => secret.name === name)) return true
  }
  return false
}

async function gh(
  args: readonly string[],
  options: { readonly cwd?: string; readonly input?: string } = {}
): Promise<string> {
  try {
    return await run(["gh", ...args], { ...options, env: ghEnvironment() })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new SixbCliError(`[SixbDeploy] gh ${args.slice(0, 2).join(" ")} failed: ${reason}`, {
      remediation:
        "`sixb deploy ci` uses the GitHub CLI. Install it, run `gh auth login`, and make sure " +
        "you can change this repository's settings.",
    })
  }
}

/**
 * Bun loads the project's `.env` into this process, and a connector's `GITHUB_TOKEN` there would
 * take precedence over the user's `gh auth login`. `GH_TOKEN` stays: it is gh's explicit override.
 */
function ghEnvironment(): Record<string, string | undefined> {
  const { GITHUB_TOKEN: _projectToken, ...env } = process.env
  return env
}

async function run(
  command: readonly string[],
  options: {
    readonly cwd?: string
    readonly input?: string
    readonly env?: Record<string, string | undefined>
  }
): Promise<string> {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(stderr.trim() || `exited with code ${exitCode}`)
  return stdout.trim()
}
