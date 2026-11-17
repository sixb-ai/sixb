import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProjectSource, SandboxConfig, SandboxEnvironment, SandboxFactory } from "../src"
import { optional, param, SixbHost } from "../src"
import { createTestSixb } from "../src/testing"
import { testLanguageModel } from "./helpers/language-model"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const forbidden = async (): Promise<never> => {
  throw new Error("Must not create a sandbox")
}
const factory: SandboxFactory = {
  supportsRequestCredentials: true,
  create: forbidden,
  resume: forbidden,
}
const operations: ProjectSource = { repository: "acme/operations" }
const auth = { authorize: forbidden }

function setup(configuration: SandboxConfig = {}, source: ProjectSource | null = operations) {
  const host = new SixbHost({
    id: "project-source",
    ontology: [],
    ...createTestRuntimeDeps(),
    sandboxes: { ...factory, configuration },
    ...(source === null ? {} : { source }),
    models: { language: [testLanguageModel()] },
  })
  return { host, sixb: createTestSixb(host) }
}

describe("a thread on a branch of the project", () => {
  test("names only its branch, and its sandbox checks that branch of the project out", async () => {
    const { host, sixb } = setup({ auth, env: { TZ: "UTC" } })
    const thread = await sixb.agent.threads.create({ sandbox: { branch: "vendor-invoices" } })
    expect(thread.sandboxParams).toEqual({ branch: "vendor-invoices" })

    const environment = await host.sandboxDefinition!.resolve({
      params: thread.sandboxParams!,
      sixb,
    })
    expect(environment).toMatchObject({
      source: { type: "git", url: "https://github.com/acme/operations.git", access: "write" },
      network: { mode: "all" },
      env: {
        TZ: "UTC",
        SIXB_SOURCE_REPOSITORY: "acme/operations",
        SIXB_SOURCE_BRANCH: "vendor-invoices",
        SIXB_SOURCE_PATH: ".",
      },
    })
    expect(environment.setup?.[0]).toContain("git checkout -b 'vendor-invoices'")
  })

  test("only reads the repository when the sandbox factory issues no source credentials", async () => {
    const { host, sixb } = setup({}, { repository: "acme/operations", path: "apps/ops" })
    const environment = await host.sandboxDefinition!.resolve({ params: { branch: "main" }, sixb })
    expect(environment.source?.access).toBe("read")
    expect(environment.env?.SIXB_SOURCE_PATH).toBe("apps/ops")
  })

  test("leaves the project's own sandbox params to its resolver", async () => {
    const resolved: unknown[] = []
    const { host, sixb } = setup({
      params: { clientId: param("string"), branch: optional(param("string")) },
      resolve: ({ params }): SandboxEnvironment => {
        resolved.push(params)
        return { env: { CLIENT: String(params.clientId) } }
      },
    })

    const project = await host.sandboxDefinition!.resolve({ params: { branch: "fix" }, sixb })
    expect(project.source?.url).toBe("https://github.com/acme/operations.git")
    expect(resolved).toEqual([])

    const own = await host.sandboxDefinition!.resolve({
      params: { clientId: "acme", branch: "fix" },
      sixb,
    })
    expect(own).toEqual({ env: { CLIENT: "acme" } })
    expect(resolved).toEqual([{ clientId: "acme", branch: "fix" }])
  })

  test("refuses a branch name git or a shell would read as something else", async () => {
    // The name reaches a setup command. Drop the `assertBranchName` call in normalizeSandboxBinding
    // and these threads are created.
    const { sixb } = setup({ auth })
    for (const branch of [
      "-x",
      "a..b",
      "a b",
      "a;rm -rf",
      "x.lock",
      "a//b",
      ".hidden",
      "a/",
      "a/.b",
      "it's",
    ]) {
      await expect(sixb.agent.threads.create({ sandbox: { branch } })).rejects.toMatchObject({
        code: "invalid_sandbox_params",
      })
    }
    expect((await sixb.agent.threads.list()).total).toBe(0)
  })

  test("without a project source, `branch` alone is just a param the recipe must declare", async () => {
    const { sixb } = setup({}, null)
    await expect(
      sixb.agent.threads.create({ sandbox: { branch: "vendor-invoices" } })
    ).rejects.toMatchObject({ code: "invalid_sandbox_params" })
  })
})

describe("the project's source", () => {
  test.each<[string, () => unknown]>([
    ["a repository not written owner/name", () => setup({}, { repository: "operations" })],
    ["a path outside the repository", () => setup({}, { repository: "acme/ops", path: "../x" })],
    [
      "a sandbox factory with a source of its own",
      () => setup({ source: { type: "git", url: "https://github.com/acme/other" } }),
    ],
    [
      "no sandboxes to work in",
      () => new SixbHost({ id: "x", ontology: [], ...createTestRuntimeDeps(), source: operations }),
    ],
  ])("is refused at startup with %s", (_case, start) => {
    expect(start).toThrow("[Sixb]")
  })
})

describe("the checkout", () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => child.kill(), 10_000)
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    clearTimeout(timer)
    if (code !== 0)
      throw new Error(`git ${args.join(" ")} failed: ${await new Response(child.stderr).text()}`)
    return output.trim()
  }

  async function runSetup(cwd: string, command: string): Promise<void> {
    const child = Bun.spawn(["bash", "-c", command], { cwd, stdout: "ignore", stderr: "ignore" })
    const timer = setTimeout(() => child.kill(), 10_000)
    expect(await child.exited).toBe(0)
    clearTimeout(timer)
  }

  test("takes an existing branch from the remote, and creates a new one from the default branch", async () => {
    // Drop the `|| git checkout -b` fallback in projectSourceEnvironment and the new branch fails.
    const root = await mkdtemp(join(tmpdir(), "sixb-project-source-"))
    roots.push(root)
    const origin = join(root, "origin")
    await git(root, "init", "-q", "-b", "main", origin)
    await git(
      origin,
      "-c",
      "user.email=e@example.com",
      "-c",
      "user.name=E",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "first"
    )
    await git(origin, "branch", "existing")
    await git(
      origin,
      "-c",
      "user.email=e@example.com",
      "-c",
      "user.name=E",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "second"
    )

    const { host, sixb } = setup({ auth })
    const checkout = async (branch: string) => {
      const directory = join(root, branch)
      await git(root, "clone", "-q", origin, directory)
      const environment = await host.sandboxDefinition!.resolve({ params: { branch }, sixb })
      await runSetup(directory, environment.setup![0]!)
      return {
        branch: await git(directory, "branch", "--show-current"),
        head: await git(directory, "log", "-1", "--format=%s"),
      }
    }

    expect(await checkout("existing")).toEqual({ branch: "existing", head: "first" })
    expect(await checkout("vendor-invoices")).toEqual({ branch: "vendor-invoices", head: "second" })
  })
})
