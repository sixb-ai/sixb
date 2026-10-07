import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { githubRepoOf, hasSecret, renderWorkflow, type WorkflowInput } from "../src/lib/github-ci"

interface Step {
  readonly name?: string
  readonly uses?: string
  readonly with?: Record<string, unknown>
  readonly env?: Record<string, string>
  readonly run?: string
  readonly "working-directory"?: string
}

const input: WorkflowInput = {
  name: "northline",
  branch: "main",
  projectPath: "examples/northline",
  bunVersionFile: "package.json",
  secrets: {
    SIXB_DEPLOY_SSH_KEY: "SIXB_DEPLOY_SSH_KEY_NORTHLINE",
    SIXB_DEPLOY_KNOWN_HOSTS: "SIXB_DEPLOY_KNOWN_HOSTS_NORTHLINE",
  },
  install: ["cat >> ~/.ssh/config <<'EOF'", "Host myvm", "  HostName 203.0.113.10", "EOF"],
  submodules: "none",
}

function parse(workflow: string) {
  const parsed = Bun.YAML.parse(workflow) as {
    on: { push: { branches: string[] } }
    permissions: Record<string, string>
    jobs: { deploy: { environment: string; steps: Step[] } }
  }
  const steps = parsed.jobs.deploy.steps
  return { parsed, steps, step: (name: string) => steps.find((step) => step.name === name) }
}

describe("the deploy workflow", () => {
  test("deploys on push with read-only permissions, from the project's directory", () => {
    const { parsed, steps, step } = parse(renderWorkflow(input))

    expect(parsed.on.push.branches).toEqual(["main"])
    expect(parsed.permissions).toEqual({ contents: "read" })
    expect(parsed.jobs.deploy.environment).toBe("production")
    // Pinned by commit: a tag can be moved to other code.
    for (const uses of steps.flatMap((candidate) => candidate.uses ?? [])) {
      expect(uses).toMatch(/@[0-9a-f]{40}$/)
    }
    expect(steps[0]?.with).toEqual({ "persist-credentials": false })
    expect(step("Deploy")).toEqual({
      name: "Deploy",
      run: "bunx sixb deploy",
      "working-directory": "examples/northline",
    })
    expect(step("Install the deploy key")?.env).toEqual({
      SIXB_DEPLOY_SSH_KEY: `\${{ secrets.SIXB_DEPLOY_SSH_KEY_NORTHLINE }}`,
      SIXB_DEPLOY_KNOWN_HOSTS: `\${{ secrets.SIXB_DEPLOY_KNOWN_HOSTS_NORTHLINE }}`,
    })
    // The heredoc keeps its own indentation once YAML strips the block's.
    expect(step("Install the deploy key")?.run).toBe(
      "cat >> ~/.ssh/config <<'EOF'\nHost myvm\n  HostName 203.0.113.10\nEOF\n"
    )
  })

  test("checks out private submodules with the token, and names it when it is missing", () => {
    const { steps } = parse(renderWorkflow({ ...input, submodules: "private" }))

    expect(steps[0]?.name).toBe("Check the token for private submodules")
    expect(steps[0]?.run).toContain("Set the SIXB_GITHUB_TOKEN secret")
    expect(steps[1]?.with).toEqual({
      "persist-credentials": false,
      submodules: "recursive",
      token: `\${{ secrets.SIXB_GITHUB_TOKEN }}`,
    })
  })

  test("checks out public submodules with CI's own token", () => {
    const { steps } = parse(renderWorkflow({ ...input, submodules: "public", projectPath: "." }))

    expect(steps[0]?.with).toEqual({ "persist-credentials": false, submodules: "recursive" })
    expect(steps.find((step) => step.name === "Deploy")?.["working-directory"]).toBeUndefined()
  })
})

describe("submodule URLs", () => {
  test("name their GitHub repository", () => {
    expect(githubRepoOf("https://github.com/acme/lib.git", "acme/shop")).toBe("acme/lib")
    expect(githubRepoOf("git@github.com:acme/lib.git", "acme/shop")).toBe("acme/lib")
    expect(githubRepoOf("ssh://git@github.com/acme/lib", "acme/shop")).toBe("acme/lib")
    expect(githubRepoOf("../lib.git", "acme/shop")).toBe("acme/lib")
    expect(githubRepoOf("../../other/lib.git", "acme/shop")).toBe("other/lib")
    expect(githubRepoOf("https://gitlab.com/acme/lib.git", "acme/shop")).toBeNull()
  })
})

describe("the GitHub CLI", () => {
  test("ignores a project GITHUB_TOKEN but honors GH_TOKEN", async () => {
    // Red check: spawn gh with process.env; the fake gh then reports the connector token.
    const bin = await mkdtemp(join(tmpdir(), "sixb-fake-gh-"))
    const saved = {
      PATH: process.env.PATH,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GH_TOKEN: process.env.GH_TOKEN,
    }
    try {
      // Lists one secret named after the tokens gh would authenticate with.
      await writeFile(
        join(bin, "gh"),
        `#!/bin/sh\nprintf '[{"name":"%s|%s"}]' "\${GITHUB_TOKEN:-none}" "\${GH_TOKEN:-none}"\n`
      )
      await chmod(join(bin, "gh"), 0o755)
      process.env.PATH = `${bin}:${saved.PATH}`
      process.env.GITHUB_TOKEN = "connector-token"
      process.env.GH_TOKEN = "explicit-token"

      const repo = { name: "acme/shop", defaultBranch: "main" }
      expect(await hasSecret(repo, "none|explicit-token")).toBe(true)
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await rm(bin, { recursive: true, force: true })
    }
  })
})
