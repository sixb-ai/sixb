import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCheck } from "../src/commands/check"
import { runDev } from "../src/commands/dev"
import { assertDeclaredEnv, loadEnvConfig, missingEnvVars } from "../src/lib/env-config"
import { errorRemediation } from "../src/lib/errors"
import { runInProcess } from "./shared/in-process"

const projects: string[] = []

afterAll(async () => {
  await Promise.all(projects.map((project) => rm(project, { recursive: true, force: true })))
})

async function project(envFile?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sixb-env-config-"))
  projects.push(dir)
  if (envFile !== undefined) await writeFile(join(dir, "sixb.env.ts"), envFile)
  return dir
}

const vars = (body: string) => `export default { vars: ${body} }\n`

describe("loadEnvConfig", () => {
  test("a project without sixb.env.ts has no declared names", async () => {
    expect(await loadEnvConfig(await project())).toBeNull()
  })

  test("returns the declared names", async () => {
    const dir = await project(vars('{ DATABASE_URL: "required", SENTRY_DSN: "optional" }'))

    expect((await loadEnvConfig(dir))?.vars).toEqual({
      DATABASE_URL: "required",
      SENTRY_DSN: "optional",
    })
  })

  test.each([
    ["no default export", "export const vars = {}\n", "has no default export"],
    ["no vars", "export default {}\n", "must set `vars`"],
    ["a bad name", vars('{ "BAD-NAME": "required" }'), '"BAD-NAME" in sixb.env.ts'],
    ["a bad rule", vars('{ DATABASE_URL: "always" }'), "DATABASE_URL in sixb.env.ts must be"],
  ])("rejects %s", async (_case, file, message) => {
    const error = await loadEnvConfig(await project(file)).catch((failure) => failure)

    expect(String(error)).toContain(message)
  })
})

describe("missingEnvVars", () => {
  const config = {
    vars: { DATABASE_URL: "required", LINKEDIN_SECRET: "prod", SENTRY_DSN: "optional" },
  } as const

  test("requires `required` names everywhere and `prod` names in prod", () => {
    expect(missingEnvVars(config, {}, "dev")).toEqual(["DATABASE_URL"])
    expect(missingEnvVars(config, {}, "prod")).toEqual(["DATABASE_URL", "LINKEDIN_SECRET"])
  })

  test("never requires `optional` names", () => {
    const values = { DATABASE_URL: "postgres://db", LINKEDIN_SECRET: "secret" }

    expect(missingEnvVars(config, values, "prod")).toEqual([])
  })

  test("counts an empty value as missing", () => {
    expect(missingEnvVars(config, { DATABASE_URL: "" }, "dev")).toEqual(["DATABASE_URL"])
  })
})

describe("commands that run the project", () => {
  const file = vars('{ SIXB_ENV_TEST_REQUIRED: "required", SIXB_ENV_TEST_PROD: "prod" }')

  test("assertDeclaredEnv names every missing variable and says what to do", async () => {
    const error = await assertDeclaredEnv(await project(file)).catch((failure) => failure)

    expect(String(error)).toContain("Missing SIXB_ENV_TEST_REQUIRED, which sixb.env.ts requires")
    expect(errorRemediation(error)).toContain(".env")
  })

  test("assertDeclaredEnv applies the prod rule under NODE_ENV=production", async () => {
    const dir = await project(file)
    const result = await runInProcess(async () => {
      process.env.NODE_ENV = "production"
      process.env.SIXB_ENV_TEST_REQUIRED = "set"
      await assertDeclaredEnv(dir)
    })

    expect(String(result.error)).toContain("Missing SIXB_ENV_TEST_PROD,")
  })

  test("assertDeclaredEnv passes without sixb.env.ts", async () => {
    expect(await assertDeclaredEnv(await project())).toBeUndefined()
  })

  // Reproduce: remove the assertDeclaredEnv call from commands/check.ts. Loading this project
  // then fails on the missing sixb.config.ts instead of naming the variable.
  test("sixb check names the variable before it loads the project", async () => {
    const entry = join(await project(file), "sixb.config.ts")
    const result = await runInProcess(() => runCheck({ entry }))

    expect(String(result.error)).toContain("Missing SIXB_ENV_TEST_REQUIRED")
  })

  // Reproduce: remove the assertDeclaredEnv call from commands/dev.ts. This then starts the
  // supervisor instead of failing, and the test times out.
  test("sixb dev names the variable before it starts anything", async () => {
    const entry = join(await project(file), "sixb.config.ts")
    const result = await runInProcess(() => runDev({ entry }))

    expect(String(result.error)).toContain("Missing SIXB_ENV_TEST_REQUIRED")
  })
})
