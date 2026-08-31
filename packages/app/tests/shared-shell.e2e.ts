import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "../../..")
const runnerPath = join(import.meta.dir, "helpers", "shared-shell-e2e-runner.ts")
const workspaceTempDir = join(repoRoot, ".local", "test-tmp")
const SCENARIO_BUDGET_MS = 45_000

type SharedShellScenario = "dev" | "production"
const scenarios: SharedShellScenario[] = ["dev", "production"]

test.each(scenarios)(
  "delivers the %s shared shell without loading app code before authority",
  async (scenario) => {
    await mkdir(workspaceTempDir, { recursive: true })
    const scenarioRoot = await mkdtemp(join(workspaceTempDir, `sixb-shared-shell-${scenario}-`))

    try {
      const result = await runScenario(scenario, scenarioRoot)
      expect(result).toEqual({ exitCode: 0, output: "" })
    } finally {
      await rm(scenarioRoot, { recursive: true, force: true })
    }
  },
  SCENARIO_BUDGET_MS + 10_000
)

/**
 * Both scenarios invoke Bun's bundler. A regression test must stay killable: reverting the shell
 * isolation or routing guards makes the child fail, while a native bundler deadlock is terminated
 * at the same deterministic boundary instead of wedging the rest of the suite.
 *
 * On Bun 1.3.14 specifically, replacing the build-like shared dev path with an HTML-bundle import
 * makes the dev scenario fail because Bun injects a script src before the inline fragment scrub.
 */
async function runScenario(
  scenario: SharedShellScenario,
  scenarioRoot: string
): Promise<{ readonly exitCode: number; readonly output: string }> {
  const proc = Bun.spawn([process.execPath, runnerPath, scenario, scenarioRoot], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(proc.stdout).text()
  const stderr = new Response(proc.stderr).text()
  let timedOut = false
  const killTimer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, SCENARIO_BUDGET_MS)

  try {
    const exitCode = await proc.exited
    const output = `${await stdout}${await stderr}`.trim()
    return {
      exitCode,
      output: timedOut
        ? `Shared shell ${scenario} scenario exceeded ${SCENARIO_BUDGET_MS}ms and was killed.`
        : exitCode === 0
          ? ""
          : output || `Shared shell ${scenario} runner exited with code ${exitCode}.`,
    }
  } finally {
    clearTimeout(killTimer)
    await Promise.all([stdout.catch(() => ""), stderr.catch(() => "")])
  }
}
