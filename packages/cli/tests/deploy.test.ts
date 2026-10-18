import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { DeployConfig, DeployRelease, DeployTarget } from "@sixb/core/deploy"
import { ACTION_RUN_DRAIN_TIMEOUT_MS } from "@sixb/core/internal/actions"
import {
  runDeploy,
  runDeployAccess,
  runDeployCheck,
  runDeployCi,
  runDeployControl,
  runDeployLogs,
  runDeploySetup,
  runDeployStatus,
} from "../src/commands/deploy"
import { parseCliArgs } from "../src/lib/command-line"
import { buildDeployRelease, deployPublicOrigins } from "../src/lib/deploy-release"
import { packSource, resolveBunVersion } from "../src/lib/deploy-source"
import { type ProductionRole, productionRoleFacts } from "../src/lib/production-roles"
import { runInProcess } from "./shared/in-process"

const fixtureProject = resolve(import.meta.dir, "fixtures", "deploy-project")

const ports = { app: 3001, api: 3002 } as const

const target: DeployTarget = {
  kind: "test",
  location: "sixb@test-server",
  listenAddress: (service) => ({ host: "127.0.0.1", port: ports[service] }),
  deploy: async () => {},
  status: async () => ({ release: null, running: false, processes: [] }),
  logs: async () => {},
  control: async () => {},
  check: async () => [],
}

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sixb-deploy-"))
  tempDirs.push(dir)
  return dir
}

function release(overrides: Partial<DeployConfig> = {}): DeployRelease {
  return buildDeployRelease(
    { name: "northline", domain: "example.com", target, ...overrides },
    { bunVersion: "1.4.2" }
  )
}

function service(built: DeployRelease, name: string) {
  const found = built.services.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`No ${name} service in the release.`)
  return found
}

function commandLine(built: DeployRelease, name: string): string {
  const { command } = service(built, name)
  return [command.program, ...command.args].join(" ")
}

// Commits name an author without a `git config` call per repository.
const gitIdentity = {
  GIT_AUTHOR_NAME: "Dev",
  GIT_AUTHOR_EMAIL: "dev@example.com",
  GIT_COMMITTER_NAME: "Dev",
  GIT_COMMITTER_EMAIL: "dev@example.com",
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-c", "protocol.file.allow=always", ...args], {
    cwd,
    env: { ...process.env, ...gitIdentity },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`)
  return stdout.trim()
}

/** A repository with its files committed, as a deploy expects. */
async function repository(files: Record<string, string>, root?: string): Promise<string> {
  root ??= await tempDir()
  await git(root, "init", "--quiet", "--initial-branch=main")
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true })
    await writeFile(join(root, path), content)
  }
  await git(root, "add", ".")
  await git(root, "commit", "--quiet", "-m", "init")
  return root
}

/** Lists the files in a tar stream. */
async function listArchive(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const tar = Bun.spawn(["tar", "-t", "-f", "-"], { stdin: new Response(stream), stdout: "pipe" })
  return (await new Response(tar.stdout).text())
    .split("\n")
    .filter((line) => line && !line.endsWith("/"))
    .sort()
}

describe("deploy release", () => {
  test("runs every Sixb service by default, rules included", () => {
    const built = release()

    expect(built.services.map((entry) => [entry.name, entry.kind])).toEqual([
      ["api", "http"],
      ["app", "http"],
      ["orchestrator", "singleton"],
      ["scheduler", "singleton"],
      ["rules", "singleton"],
      ["workers", "workers"],
    ])
    expect(built.bunVersion).toBe("1.4.2")
    expect(commandLine(built, "api")).toBe("sixb api --host 127.0.0.1 --port 3002 --no-migrate")
    expect(service(built, "api").http?.readinessPath).toBe("/ready")
    expect(commandLine(built, "app")).toBe("sixb app --host 127.0.0.1 --port 3001")
    expect(commandLine(built, "rules")).toBe("sixb rules --no-migrate")
    expect(commandLine(built, "workers")).toBe("sixb worker-group --no-migrate")
    expect(built.steps).toEqual({
      build: [{ program: "sixb", args: ["build"] }],
      beforeStart: [
        { program: "sixb", args: ["db", "migrate"] },
        { program: "sixb", args: ["check"] },
        { program: "sixb", args: ["lake", "check"] },
      ],
    })
  })

  // Reproduce: rename `--no-migrate` or `--agent-turn-timeout` in command-line.ts, or drop an
  // option from a role's command, and this fails for the release that uses it.
  test("starts every Sixb service with a command the CLI accepts", () => {
    const built = release({
      services: {
        workers: {
          types: ["sync", "agent"],
          agentTurnTimeout: "30m",
          concurrency: { sync: 2, agent: 8 },
        },
      },
    })
    const roles: Readonly<Record<string, ProductionRole>> = {
      api: "api",
      app: "app",
      orchestrator: "orchestrator",
      scheduler: "scheduler",
      rules: "rules",
      workers: "worker-group",
    }

    for (const entry of built.services) {
      const role = roles[entry.name]
      if (!role) throw new Error(`No role for ${entry.name}.`)
      const parsed = parseCliArgs(entry.command.args)
      expect(parsed).toMatchObject({ kind: "command", id: role })
      if (parsed.kind !== "command") continue
      expect(parsed.options["no-migrate"] === true).toBe(
        productionRoleFacts(role).usesStorageSchema
      )
    }
    for (const step of [...built.steps.build, ...built.steps.beforeStart]) {
      expect(parseCliArgs(step.args).kind).toBe("command")
    }
    expect(commandLine(built, "workers")).toBe(
      "sixb worker-group sync agent --agent-turn-timeout 30m " +
        "--concurrency sync=2 --concurrency agent=8 --no-migrate"
    )
  })

  // The API and the workers run Actions in process, and wait for those in flight before closing
  // storage. Guard proof: drop either service from `ACTION_HOST_SERVICES` in
  // `src/lib/deploy-release.ts`, or raise the drain bound in core past the default, and a graceful
  // restart kills Actions that service was still running.
  test("lets a stopping API or worker group finish the Actions it is running", () => {
    const built = release()

    expect(
      built.services.map((entry) => [
        entry.name,
        entry.process.killTimeoutMs > ACTION_RUN_DRAIN_TIMEOUT_MS,
      ])
    ).toEqual([
      ["api", true],
      ["app", false],
      ["orchestrator", false],
      ["scheduler", false],
      ["rules", false],
      ["workers", true],
    ])
    const overridden = release({
      services: {
        api: { process: { killTimeoutMs: 60_000 } },
        workers: { process: { killTimeoutMs: 5_000 } },
      },
    })
    expect(service(overridden, "api").process.killTimeoutMs).toBe(60_000)
    expect(service(overridden, "workers").process.killTimeoutMs).toBe(5_000)
  })

  test("gives every service the public origins, then its own environment", () => {
    const built = release({
      env: { SIXB_ERROR_EMAIL_TO: "ops@example.com" },
      services: {
        app: { domain: "ops.example.com" },
        api: { env: { POSTGRES_POOL_MAX: "6" } },
        scheduler: false,
      },
    })

    expect(built.env).toEqual({
      NODE_ENV: "production",
      SIXB_API_PUBLIC_ORIGIN: "https://northline-api.example.com",
      SIXB_APP_PUBLIC_ORIGIN: "https://ops.example.com",
      SIXB_ERROR_EMAIL_TO: "ops@example.com",
    })
    expect(service(built, "api").env).toEqual({ ...built.env, POSTGRES_POOL_MAX: "6" })
    expect(service(built, "workers").env).toEqual(built.env)
    expect(service(built, "app").http).toEqual({
      host: "127.0.0.1",
      port: 3001,
      domain: "ops.example.com",
      publicOrigin: "https://ops.example.com",
    })
    expect(built.services.some((entry) => entry.name === "scheduler")).toBe(false)
  })

  test("tells a desktop build where browsers reach the app and the API", () => {
    expect(
      deployPublicOrigins({
        name: "northline",
        domain: "example.com",
        target,
        services: { app: { domain: "ops.example.com" } },
      })
    ).toEqual({ api: "https://northline-api.example.com", app: "https://ops.example.com" })
  })

  test("supervises project processes with Bun", () => {
    const built = release({
      processes: {
        "nas-watcher": {
          entrypoint: "scripts/nas-watch.ts",
          args: ["--recursive"],
          env: { WATCH_MODE: "recursive" },
          process: { instances: 2, maxMemory: "256M" },
        },
      },
    })

    expect(service(built, "nas-watcher")).toEqual({
      name: "nas-watcher",
      kind: "script",
      command: { program: "bun", args: ["scripts/nas-watch.ts", "--recursive"] },
      env: { ...built.env, WATCH_MODE: "recursive" },
      instances: 2,
      process: { killTimeoutMs: 10_000, restartDelayMs: 1_000, maxMemory: "256M" },
    })
  })

  test("refuses what would collide or never resolve", () => {
    expect(() => release({ domain: undefined })).toThrow("services.api has no domain")
    expect(() => release({ services: { app: { domain: "northline-api.example.com" } } })).toThrow(
      "services.api and services.app both use northline-api.example.com"
    )
    expect(() =>
      release({ target: { ...target, listenAddress: () => ({ host: "127.0.0.1", port: 3000 }) } })
    ).toThrow("api and app both listen on port 3000")
    expect(() => release({ services: { workers: { agentTurnTimeout: "10 minutes" } } })).toThrow(
      "agentTurnTimeout '10 minutes' is not a duration"
    )
  })
})

describe("deploy source", () => {
  test("sends the committed files, with each submodule at its recorded commit", async () => {
    const library = await repository({ "index.ts": "export {}" })
    const root = await repository({ "package.json": "{}", "src/app.ts": "app" })
    await git(root, "submodule", "add", "--quiet", library, "vendor/lib")
    await git(root, "commit", "--quiet", "-m", "vendor")
    await writeFile(join(root, "src/app.ts"), "uncommitted")
    await writeFile(join(root, "notes.txt"), "untracked")

    const source = await packSource(root)
    const [repositoryArchive, submoduleArchive] = source.archives

    expect(source.commit).toBe(await git(root, "rev-parse", "HEAD"))
    expect(source.projectPath).toBe(".")
    expect(source.dirty).toBe(true)
    expect(source.archives.map((archive) => archive.path)).toEqual([".", "vendor/lib"])
    if (!repositoryArchive || !submoduleArchive) throw new Error("Missing archives.")
    expect(await listArchive(repositoryArchive.open())).toEqual([
      ".gitmodules",
      "package.json",
      "src/app.ts",
    ])
    expect(await listArchive(submoduleArchive.open())).toEqual(["index.ts"])
  })

  test("knows where a project sits in its repository, and runs the Bun its commit pins", async () => {
    const root = await repository({
      "package.json": JSON.stringify({ packageManager: "bun@1.4.7" }),
      "apps/web/package.json": "{}",
    })
    const project = join(root, "apps/web")

    expect((await packSource(project)).projectPath).toBe("apps/web")
    expect(await resolveBunVersion(project)).toBe("1.4.7")

    // An uncommitted edit is not what gets deployed.
    await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "bun@1.4.9" }))
    expect(await resolveBunVersion(root, await packSource(root))).toBe("1.4.7")
    expect(await resolveBunVersion(root)).toBe("1.4.9")
  })

  test("refuses a ref that is not a commit, or a project that was never committed", async () => {
    const root = await repository({ "README.md": "" })

    await expect(packSource(root, "no-such-branch")).rejects.toThrow("is not a commit")
    await expect(packSource(root)).rejects.toThrow("has no package.json")
  })
})

describe("sixb deploy", () => {
  /** A deploy config whose target records what `sixb deploy` hands it. */
  const recordingConfig = `
import { appendFileSync } from "node:fs"
const record = (value) => appendFileSync(process.env.DEPLOY_RECORD, JSON.stringify(value) + "\\n")
export default {
  name: "northline",
  domain: "example.com",
  target: {
    kind: "test",
    location: "sixb@test-server",
    listenAddress: (service) => ({ host: "127.0.0.1", port: { app: 3001, api: 3002 }[service] }),
    async deploy(release, source, context) {
      context.report({ type: "steps", labels: ["Upload source", "Build"] })
      context.report({ type: "step", index: 0, status: "running" })
      const archives = []
      for (const archive of source.archives) {
        archives.push({ path: archive.path, bytes: (await new Response(archive.open()).arrayBuffer()).byteLength })
      }
      context.report({ type: "step", index: 0, status: "done" })
      context.report({ type: "step", index: 1, status: "running" })
      context.report({ type: "output", line: "compiling the runtime" })
      record({ name: context.name, bunVersion: release.bunVersion, commit: source.commit, ref: source.ref, archives, deployedBy: context.deployedBy })
      if (process.env.DEPLOY_FAIL) throw new Error("the build broke")
      context.report({ type: "step", index: 1, status: "done" })
    },
    async status() {
      return { release: { commit: "abc123", ref: "main", deployedAt: new Date().toISOString(), deployedBy: "ci" }, running: true, processes: [{ service: "api", instance: 0, status: "running", restarts: 0 }] }
    },
    async logs(options, context) {
      options.write(context.name + " " + (options.service ?? "all") + " tail=" + options.tail + " follow=" + options.follow)
    },
    async control(action, service, context) {
      record({ action, service, name: context.name })
    },
    async check(release, context) {
      record({ check: context.name, projectPath: context.projectPath })
      return [
        { id: "ssh", label: "SSH", status: "ok", detail: "sixb@test-server" },
        ...(process.env.DEPLOY_BLOCK
          ? [{ id: "project.env", label: ".env", status: "manual", detail: ".env does not exist", remedy: "Create it." }]
          : []),
      ]
    },
    async setup(release, context) {
      record({ setup: context.name, admin: context.admin ?? null, key: context.key ?? null })
      context.write("setting up the test server")
    },
    access: {
      async list() {
        return [{ type: "ssh-ed25519", fingerprint: "SHA256:abc", comment: "dev@laptop", restricted: false }]
      },
      async add(key) {
        record({ add: key })
        return { type: "ssh-ed25519", fingerprint: "SHA256:new", comment: key.split(" ")[2] ?? "", restricted: false }
      },
      async remove(match) {
        record({ remove: match })
        return [{ type: "ssh-ed25519", fingerprint: match, comment: "old@laptop", restricted: false }]
      },
    },
    ci: {
      async create(job, context) {
        record({ ci: job, name: context.name })
        return {
          description: "SHA256:ci for sixb@test-server",
          secrets: { SIXB_DEPLOY_SSH_KEY: "the private key", SIXB_DEPLOY_KNOWN_HOSTS: "test-server ssh-ed25519 AAAA" },
          install: ["echo installing the key"],
          async retireOthers() {
            record({ retired: job })
            return [{ type: "ssh-ed25519", fingerprint: "SHA256:old", comment: job, restricted: true }]
          },
          async revoke() {
            record({ revoked: job })
          },
        }
      },
    },
  },
}
`

  /** A \`gh\` that records each call, with what it read on stdin, and answers like GitHub. */
  async function fakeGh(): Promise<{ path: string; calls: () => Promise<string[]> }> {
    const bin = await tempDir()
    const log = join(bin, "calls.log")
    await writeFile(
      join(bin, "gh"),
      [
        "#!/bin/sh",
        'if [ "$1 $2" = "secret set" ]; then input="$(cat)"; else input=""; fi',
        `printf '%s <%s>\\n' "$*" "$input" >> ${JSON.stringify(log)}`,
        'case "$1 $2" in',
        '  "repo view") echo \'{"nameWithOwner":"acme/shop","defaultBranchRef":{"name":"main"}}\' ;;',
        '  "secret set") [ -z "$GH_FAIL_SECRETS" ] || { echo "HTTP 403: Resource not accessible" >&2; exit 1; } ;;',
        '  "secret list") echo "[]" ;;',
        '  "api repos/acme/shop/environments/production") [ -n "$GH_ENVIRONMENT_EXISTS" ] || exit 1 ;;',
        "  api\\ repos/acme/*) echo true ;;",
        "esac",
      ].join("\n"),
      { mode: 0o755 }
    )
    return {
      path: `${bin}:${process.env.PATH}`,
      calls: async () =>
        (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean),
    }
  }

  /** A committed project with the recording config, and a fresh file for what its target records. */
  async function project(): Promise<{ root: string; recordPath: string }> {
    const root = await repository({
      "package.json": JSON.stringify({ packageManager: "bun@1.4.2" }),
      "sixb.deploy.ts": recordingConfig,
    })
    return { root, recordPath: join(await tempDir(), "record.jsonl") }
  }

  // One project for the commands that leave it as it was; `deploy ci` writes to its own.
  let readOnlyRoot: Promise<string> | undefined
  afterAll(async () => {
    if (readOnlyRoot) await rm(await readOnlyRoot, { recursive: true, force: true })
  })

  async function readOnlyProject(): Promise<{ root: string; recordPath: string }> {
    readOnlyRoot ??= mkdtemp(join(tmpdir(), "sixb-deploy-project-")).then((root) =>
      repository(
        {
          "package.json": JSON.stringify({ packageManager: "bun@1.4.2" }),
          "sixb.deploy.ts": recordingConfig,
        },
        root
      )
    )
    return { root: await readOnlyRoot, recordPath: join(await tempDir(), "record.jsonl") }
  }

  async function records(path: string): Promise<Record<string, unknown>[]> {
    return (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  /**
   * Runs a deploy command in this process, the way CI sees it: one line per step rather than a
   * live view. `env` reaches the recording target and the fake `gh`.
   */
  function deploy(env: Record<string, string>, command: () => Promise<unknown>) {
    return runInProcess(() => {
      Object.assign(process.env, { CI: "1", ...env })
      return command()
    })
  }

  test("hands the target the release and the committed source", async () => {
    const { root, recordPath } = await readOnlyProject()
    const result = await deploy({ DEPLOY_RECORD: recordPath }, () => runDeploy({ cwd: root }))

    expect(result.error).toBeUndefined()
    expect(result.exitCode).toBeUndefined()
    expect(result.output).toContain("✓ Upload source")
    expect(result.output).toContain("northline deployed")
    const [checked, deployed] = await records(recordPath)
    expect(checked).toEqual({ check: "northline", projectPath: "." })
    expect(deployed).toMatchObject({
      name: "northline",
      bunVersion: "1.4.2",
      commit: await git(root, "rev-parse", "HEAD"),
      ref: "HEAD",
    })
    expect((deployed?.archives as { bytes: number }[])[0]?.bytes).toBeGreaterThan(0)
    expect(deployed?.deployedBy).toBeTruthy()
  })

  test("names the step that failed, with its output", async () => {
    const { root, recordPath } = await readOnlyProject()
    const result = await deploy({ DEPLOY_RECORD: recordPath, DEPLOY_FAIL: "1" }, () =>
      runDeploy({ cwd: root })
    )

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('Deploy failed at "Build"')
    expect(result.output).toContain("compiling the runtime")
    expect(result.output).toContain("the build broke")
  })

  test("reports status, logs, and control through the target", async () => {
    const { root, recordPath } = await readOnlyProject()
    const env = { DEPLOY_RECORD: recordPath }

    const status = await deploy(env, () => runDeployStatus({ json: true, cwd: root }))
    expect(JSON.parse(status.output).processes[0]).toMatchObject({
      service: "api",
      status: "running",
    })

    const logs = await deploy(env, () => runDeployLogs({ service: "api", tail: "5", cwd: root }))
    expect(logs.output).toContain("northline api tail=5 follow=false")

    const restart = await deploy(env, () =>
      runDeployControl({ action: "restart", service: "workers", cwd: root })
    )
    expect(restart.error).toBeUndefined()
    expect(restart.output).toContain("northline is running")
    expect(await records(recordPath)).toEqual([
      { action: "restart", service: "workers", name: "northline" },
    ])
  })

  test("checks the target, and stops a deploy the checks say cannot work", async () => {
    const { root, recordPath } = await readOnlyProject()
    const env = { DEPLOY_RECORD: recordPath, DEPLOY_BLOCK: "1" }

    const check = await deploy(env, () => runDeployCheck({ cwd: root }))
    expect(check.exitCode).toBe(1)
    expect(check.output).toContain("northline · 1 to fix before deploying")
    expect(check.output).toContain("Create it.")

    const blocked = await deploy(env, () => runDeploy({ cwd: root }))
    expect(blocked.exitCode).toBe(1)
    expect(blocked.output).toContain(".env does not exist")
    // Only the checks ran: nothing was uploaded.
    expect((await records(recordPath)).every((entry) => "check" in entry)).toBe(true)
  })

  test("sets the target up, then shows what is left", async () => {
    const { root, recordPath } = await readOnlyProject()
    const result = await deploy({ DEPLOY_RECORD: recordPath }, () =>
      runDeploySetup({ admin: "ademattos", key: "~/.ssh/id.pub", cwd: root })
    )

    expect(result.error).toBeUndefined()
    expect(result.output).toContain("setting up the test server")
    expect(result.output).toContain("northline is ready to deploy")
    expect((await records(recordPath))[0]).toEqual({
      setup: "northline",
      admin: "ademattos",
      key: "~/.ssh/id.pub",
    })
  })

  test("sets up GitHub Actions, storing the new key before revoking the old", async () => {
    const { root, recordPath } = await project()
    await writeFile(
      join(root, ".gitmodules"),
      '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = ../lib.git\n'
    )
    const gh = await fakeGh()
    const env = { DEPLOY_RECORD: recordPath, PATH: gh.path }
    const result = await deploy(env, () => runDeployCi({ cwd: root }))

    expect(result.error).toBeUndefined()
    expect(result.output).toContain("northline deploys from GitHub Actions on every push to main")
    expect(result.output).toContain("revoked SHA256:old")
    expect(result.output).toContain("vendor/lib is private")
    expect(result.output).toContain("Contents: read on acme/lib")
    expect(await gh.calls()).toEqual([
      "repo view --json nameWithOwner,defaultBranchRef <>",
      "api repos/acme/lib --jq .private <>",
      "api repos/acme/shop/environments/production --silent <>",
      "api --method PUT repos/acme/shop/environments/production --silent <>",
      "secret set SIXB_DEPLOY_SSH_KEY_NORTHLINE --env production --repo acme/shop <the private key>",
      "secret set SIXB_DEPLOY_KNOWN_HOSTS_NORTHLINE --env production --repo acme/shop <test-server ssh-ed25519 AAAA>",
      "secret list --env production --repo acme/shop --json name <>",
      "secret list --repo acme/shop --json name <>",
    ])
    expect(await records(recordPath)).toEqual([
      { ci: "github:acme/shop", name: "northline" },
      { retired: "github:acme/shop" },
    ])

    const workflow = await readFile(join(root, ".github/workflows/deploy-northline.yml"), "utf8")
    expect(workflow).toContain("bun-version-file: package.json")
    expect(workflow).toContain(`SIXB_DEPLOY_SSH_KEY: \${{ secrets.SIXB_DEPLOY_SSH_KEY_NORTHLINE }}`)
    expect(workflow).toContain("          echo installing the key")
    expect(workflow).toContain(`token: \${{ secrets.SIXB_GITHUB_TOKEN }}`)

    // Running it again rotates the key without undoing edits to the workflow.
    const path = join(root, ".github/workflows/deploy-northline.yml")
    const edited = `${workflow}# edited\n`
    await writeFile(path, edited)
    const again = await deploy(env, () => runDeployCi({ cwd: root }))
    expect(again.error).toBeUndefined()
    expect(again.output).toContain("(yours, kept")
    expect(await readFile(path, "utf8")).toBe(edited)
  })

  test("revokes the new CI key when GitHub does not take it", async () => {
    const { root, recordPath } = await project()
    const gh = await fakeGh()
    const result = await deploy(
      {
        DEPLOY_RECORD: recordPath,
        PATH: gh.path,
        GH_FAIL_SECRETS: "1",
        GH_ENVIRONMENT_EXISTS: "1",
      },
      () => runDeployCi({ cwd: root })
    )

    // An existing environment is left as it is: a PUT would reset its protection rules.
    expect((await gh.calls()).some((call) => call.includes("--method PUT"))).toBe(false)
    expect(String(result.error)).toContain("Resource not accessible")
    expect(await records(recordPath)).toEqual([
      { ci: "github:acme/shop", name: "northline" },
      { revoked: "github:acme/shop" },
    ])
  })

  test("lists, adds, and revokes keys", async () => {
    const { root, recordPath } = await readOnlyProject()
    const keyFile = join(await tempDir(), "teammate.pub")
    await writeFile(keyFile, "ssh-ed25519 AAAAteammate quentin@mbp\n")
    const env = { DEPLOY_RECORD: recordPath }

    const list = await deploy(env, () => runDeployAccess({ action: "list", cwd: root }))
    expect(list.output).toContain("dev@laptop")
    const add = await deploy(env, () =>
      runDeployAccess({ action: "add", value: keyFile, cwd: root })
    )
    expect(add.output).toContain("quentin@mbp")
    const remove = await deploy(env, () =>
      runDeployAccess({ action: "remove", value: "SHA256:old", cwd: root })
    )
    expect(remove.output).toContain("old@laptop")
    expect(await records(recordPath)).toEqual([
      { add: "ssh-ed25519 AAAAteammate quentin@mbp" },
      { remove: "SHA256:old" },
    ])
  })

  test("prints the release as JSON", async () => {
    const result = await deploy({}, () =>
      runDeploy({ dryRun: true, json: true, cwd: fixtureProject })
    )

    expect(result.error).toBeUndefined()
    const built = JSON.parse(result.output) as DeployRelease
    expect(built.target).toEqual({ kind: "ssh", location: "sixb@203.0.113.10" })
    expect(built.services.map((entry) => entry.name)).toEqual([
      "api",
      "app",
      "orchestrator",
      "rules",
      "workers",
    ])
    expect(service(built, "api").http?.port).toBe(3012)
    expect(service(built, "app").http?.publicOrigin).toBe("https://ops.example.com")
  })

  test("prints the release for people", async () => {
    const result = await deploy({}, () => runDeploy({ dryRun: true, cwd: fixtureProject }))

    expect(result.error).toBeUndefined()
    expect(result.output).toContain("northline · dry run")
    expect(result.output).toContain("ssh sixb@203.0.113.10 · sixb.deploy.ts")
    expect(result.output).toContain("sixb api --host 127.0.0.1 --port 3012 --no-migrate")
    expect(result.output).toContain("Nothing was deployed")
  })

  test("explains a missing sixb.deploy.ts", async () => {
    const cwd = await tempDir()
    const result = await deploy({}, () => runDeploy({ dryRun: true, json: true, cwd }))

    expect(String(result.error)).toContain("No sixb.deploy.ts in")
  })
})

describe("deploy command line", () => {
  test("runs deploy itself, or one of its subcommands", () => {
    expect(parseCliArgs(["deploy"])).toMatchObject({ kind: "command", id: "deploy" })
    expect(parseCliArgs(["deploy", "--ref", "main"])).toMatchObject({
      id: "deploy",
      options: { ref: "main" },
    })
    expect(parseCliArgs(["deploy", "logs", "api", "--follow"])).toMatchObject({
      id: "deploy:logs",
      positionals: ["api"],
      options: { follow: true },
    })
    expect(parseCliArgs(["deploy", "setup", "--admin", "root"])).toMatchObject({
      id: "deploy:setup",
      options: { admin: "root" },
    })
    expect(parseCliArgs(["deploy", "access", "add", "github:quentin"])).toMatchObject({
      id: "deploy:access:add",
      positionals: ["github:quentin"],
    })
    expect(parseCliArgs(["deploy", "--help"]).kind).toBe("help")
    expect(() => parseCliArgs(["deploy", "statsu"])).toThrow("Unknown deploy command 'statsu'")
  })
})
