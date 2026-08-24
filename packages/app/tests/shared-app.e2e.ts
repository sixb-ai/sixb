import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "../../..")
const runnerPath = join(import.meta.dir, "helpers", "shared-app-e2e-runner.ts")
const workspaceTempDir = join(repoRoot, ".local", "test-tmp")
const SCENARIO_BUDGET_MS = 60_000

type SharedAppE2eScenario = "dev-shells" | "production-shells" | "html-entries"

const scenarios: SharedAppE2eScenario[] = ["dev-shells", "production-shells", "html-entries"]

test.each(scenarios)(
  "runs the shared app %s bundling scenario in a bounded child process",
  async (scenario) => {
    await mkdir(workspaceTempDir, { recursive: true })
    const scenarioRoot = await mkdtemp(join(workspaceTempDir, `sixb-shared-${scenario}-`))

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
 * The app runtime invokes Bun's HTML bundler. Running it inside this test process would make a
 * native bundler deadlock survive the test timeout and wedge every later test. The child is
 * killable, so the timeout below remains a real bound.
 */
async function runScenario(
  scenario: (typeof scenarios)[number],
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
        ? `Shared app ${scenario} bundling did not finish within ${SCENARIO_BUDGET_MS}ms and was killed.`
        : exitCode === 0
          ? ""
          : output || `Shared app ${scenario} runner exited with code ${exitCode}.`,
    }
  } finally {
    clearTimeout(killTimer)
    await Promise.all([stdout.catch(() => ""), stderr.catch(() => "")])
  }
}
