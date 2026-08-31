import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { AGENT_API_ROUTES } from "@sixb/core/internal/agents"
import { runAgentCliContractSuite } from "./agent-cli-contract"

const launcherPath = resolve(import.meta.dir, "..", "src", "agent-cli", "bin", "sixb")
const artifactPath = resolve(import.meta.dir, "..", "src", "agent-cli", "generated", "sixb.mjs")
const GENERATOR_CHECK_TIMEOUT_MS = 10_000

runAgentCliContractSuite({
  name: "generated artifact on Bun",
  command: [process.execPath, artifactPath],
  version: "sixb agent CLI 1",
})

runAgentCliContractSuite({
  name: "generated artifact on Node",
  command: ["node", artifactPath],
  version: "sixb agent CLI 1",
})

const CLI_API_ROUTES = [
  "GET /api/project",
  "GET /api/object-types",
  "GET /api/object-types/:objectTypeId",
  "GET /api/objects",
  "POST /api/objects/query",
  "POST /api/objects/query/links",
  "POST /api/objects/query/count",
  "POST /api/objects/query/exists",
  "POST /api/objects/query/facets",
  "POST /api/telemetry/history",
  "GET /api/objects/:objectTypeId/:objectId/telemetry/:propertyId/history",
  "GET /api/objects/:objectTypeId/:objectId/telemetry/:propertyId/latest",
  "GET /api/objects/:objectTypeId/:objectId/files/content",
  "GET /api/actions",
  "GET /api/actions/:actionId",
  "POST /api/actions/:actionId",
  "POST /api/files",
  "GET /api/action-runs",
  "GET /api/action-runs/:runId",
  "GET /api/action-runs/:runId/files/content",
  "GET /api/workflows",
  "GET /api/workflows/:workflowId",
  "POST /api/workflows/:workflowId/runs",
  "GET /api/workflow-runs",
  "GET /api/workflow-runs/:runId",
  "GET /api/workflow-runs/:runId/files/content",
  "GET /api/objects/search",
] as const

const INTENTIONAL_CLI_ROUTE_ALTERNATIVES = new Map([
  [
    "GET /api/objects/:objectTypeId/:objectId",
    "Exact object reads use POST /api/objects/query with opaque refs.",
  ],
  [
    "GET /api/agent-threads/:threadId/messages/:messageId/files/content",
    "Run attachments are materialized in the sandbox before the model starts.",
  ],
])

describe("Sixb agent CLI route coverage", () => {
  test("accounts for every route exposed by the agent API gateway", () => {
    const direct = new Set<string>(CLI_API_ROUTES)
    const alternatives = new Set(INTENTIONAL_CLI_ROUTE_ALTERNATIVES.keys())
    expect([...direct].filter((route) => alternatives.has(route))).toEqual([])
    expect([...INTENTIONAL_CLI_ROUTE_ALTERNATIVES.values()].every(Boolean)).toBe(true)

    const accountedFor = [...direct, ...alternatives].sort()
    const exposed = AGENT_API_ROUTES.map((route) => `${route.method} ${route.path}`).sort()
    expect(accountedFor).toEqual(exposed)
  })
})

describe("Sixb agent CLI generated artifact", () => {
  test(
    "is current and has no workspace or third-party runtime imports",
    async () => {
      const check = Bun.spawn({
        cmd: [process.execPath, "./scripts/generate-agent-cli.ts", "--check"],
        cwd: resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      })
      let timedOut = false
      const killTimer = setTimeout(() => {
        timedOut = true
        check.kill("SIGKILL")
      }, GENERATOR_CHECK_TIMEOUT_MS)
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          check.exited,
          new Response(check.stdout).text(),
          new Response(check.stderr).text(),
        ])
        if (timedOut) {
          throw new Error(
            `Agent CLI generation exceeded ${GENERATOR_CHECK_TIMEOUT_MS}ms and was killed.`
          )
        }
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
        expect(stdout).toContain("Generated CLI is current")

        const artifact = await readFile(artifactPath, "utf8")
        expect(artifact).not.toMatch(/from\s+["']@sixb\//)
        expect(artifact).not.toMatch(/from\s+["']ai(?:\/|["'])/)
        expect(artifact).not.toContain("curl")
        expect(artifact).not.toContain("jq")
        expect(Buffer.byteLength(artifact)).toBeLessThan(200_000)
      } finally {
        clearTimeout(killTimer)
      }
    },
    GENERATOR_CHECK_TIMEOUT_MS + 5_000
  )

  test("launcher falls back to Node and reports a stable error when neither runtime exists", async () => {
    const nodePath = Bun.which("node")
    const shPath = Bun.which("sh")
    const dirnamePath = Bun.which("dirname")
    if (!nodePath || !shPath || !dirnamePath) throw new Error("Expected host runtime tools.")
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-agent-cli-launcher-"))
    try {
      await Promise.all([
        symlink(nodePath, join(tempDir, "node")),
        symlink(shPath, join(tempDir, "sh")),
        symlink(dirnamePath, join(tempDir, "dirname")),
      ])
      const nodeFallback = Bun.spawn({
        cmd: [launcherPath, "--version"],
        env: { PATH: tempDir },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await nodeFallback.exited).toBe(0)
      expect(await new Response(nodeFallback.stdout).text()).toBe("sixb agent CLI 1\n")
      expect(await new Response(nodeFallback.stderr).text()).toBe("")

      await rm(join(tempDir, "node"))
      const unavailable = Bun.spawn({
        cmd: [launcherPath, "--version"],
        env: { PATH: tempDir },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await unavailable.exited).toBe(2)
      expect(await new Response(unavailable.stdout).text()).toBe("")
      expect(JSON.parse(await new Response(unavailable.stderr).text())).toEqual({
        error: {
          code: "runtime_unavailable",
          message: "The Sixb CLI requires Bun or Node.js.",
        },
      })

      await symlink(launcherPath, join(tempDir, "sixb"))
      const missingArtifact = Bun.spawn({
        cmd: [join(tempDir, "sixb"), "--version"],
        env: { PATH: tempDir },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await missingArtifact.exited).toBe(2)
      expect(await new Response(missingArtifact.stdout).text()).toBe("")
      expect(JSON.parse(await new Response(missingArtifact.stderr).text())).toEqual({
        error: {
          code: "runtime_unavailable",
          message: "The Sixb CLI artifact is missing.",
        },
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("launcher resolves as bare sixb through the sandbox Bash bootstrap", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-agent-cli-path-"))
    try {
      const binDir = join(tempDir, "bin")
      const libDir = join(tempDir, "lib")
      const bashEnvPath = join(tempDir, "bash-env")
      await mkdir(binDir)
      await mkdir(libDir)
      await Promise.all([
        writeFile(join(binDir, "sixb"), await readFile(launcherPath)),
        writeFile(join(libDir, "sixb.mjs"), await readFile(artifactPath)),
      ])
      await chmod(join(binDir, "sixb"), 0o755)
      await writeFile(
        bashEnvPath,
        [
          `if [ -n "\${SIXB_BIN_DIR:-}" ]; then`,
          '  export PATH="$SIXB_BIN_DIR:$PATH"',
          "fi",
          "",
        ].join("\n")
      )
      const child = Bun.spawn({
        cmd: ["bash", "-lc", "command -v sixb && sixb --version"],
        env: { ...process.env, BASH_ENV: bashEnvPath, SIXB_BIN_DIR: binDir },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
      expect(stdout).toBe(`${join(binDir, "sixb")}\nsixb agent CLI 1\n`)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
