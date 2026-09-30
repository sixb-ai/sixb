import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import type { DeployStatus } from "@sixb/core/deploy"

/**
 * Deploys Northline to a real server prepared for `sixb deploy`, then drives it through the CLI.
 * Runs only when SIXB_DEPLOY_TEST_HOST and SIXB_DEPLOY_TEST_DOMAIN name that server and a domain
 * whose subdomains point at it. Deploys the committed Northline, so commit first.
 */
const host = process.env.SIXB_DEPLOY_TEST_HOST
const domain = process.env.SIXB_DEPLOY_TEST_DOMAIN
const northline = resolve(import.meta.dir, "../../../examples/northline")
const cli = resolve(import.meta.dir, "../../../packages/cli/src/index.tsx")

async function sixb(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: northline,
    env: { ...process.env, NORTHLINE_DEPLOY_HOST: host, NORTHLINE_DEPLOY_DOMAIN: domain, CI: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

describe.skipIf(!host || !domain)("sixb deploy to a server", () => {
  test(
    "deploys Northline, then reports, restarts, and reads its services",
    async () => {
      const deployed = await sixb("deploy")
      expect(deployed.exitCode, deployed.stdout + deployed.stderr).toBe(0)
      expect(deployed.stdout).toContain("✓ Check services")

      const status = JSON.parse((await sixb("deploy", "status", "--json")).stdout) as DeployStatus
      expect(status.running).toBe(true)
      expect(status.processes.every((process) => process.status === "running")).toBe(true)

      expect((await sixb("deploy", "restart", "workers")).exitCode).toBe(0)
      expect((await sixb("deploy", "logs", "api", "--tail", "5")).exitCode).toBe(0)

      const ready = await fetch(`https://northline-api.${domain}/ready`)
      expect(ready.status).toBe(200)
    },
    15 * 60_000
  )
})
