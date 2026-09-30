import { describe, expect, test } from "bun:test"
import * as deploy from "@sixb/core/deploy"
import { type DeployConfig, type DeployTarget, defineDeploy } from "@sixb/core/deploy"
import { validateDeployConfig } from "@sixb/core/internal/deploy"

const target: DeployTarget = {
  kind: "test",
  location: "test-server",
  listenAddress: () => ({ host: "127.0.0.1", port: 3000 }),
  deploy: async () => {},
  status: async () => ({ release: null, running: false, processes: [] }),
  logs: async () => {},
  control: async () => {},
}

function config(overrides: Record<string, unknown> = {}): unknown {
  return { name: "northline", domain: "example.com", target, ...overrides }
}

function rejects(value: unknown, message: string | RegExp): void {
  expect(() => validateDeployConfig(value)).toThrow(message)
}

describe("deploy config validation", () => {
  test("accepts every setting a deployment can use", () => {
    const full = defineDeploy({
      name: "northline",
      domain: "example.com",
      target,
      env: { SIXB_ERROR_EMAIL_TO: "ops@example.com" },
      services: {
        api: { domain: "api.example.com", env: { POSTGRES_POOL_MAX: "6" }, process: {} },
        atlas: false,
        app: true,
        orchestrator: { process: { killTimeoutMs: 30_000 } },
        scheduler: false,
        rules: { env: { RULES_DEBUG: "1" } },
        workers: {
          types: ["sync", "agent", "action"],
          agentTurnTimeout: "30m",
          concurrency: { sync: 2, agent: 8 },
          process: { instances: 2, maxMemory: "1.5G" },
        },
      },
      processes: {
        "nas-watcher": {
          entrypoint: "scripts/nas-watch.ts",
          args: ["--recursive"],
          process: { restartDelayMs: 5_000, maxMemory: "256M" },
        },
      },
    })

    expect(validateDeployConfig(full)).toBe(full as DeployConfig)
  })

  test("requires a deploy target", () => {
    rejects(config({ target: undefined }), "[SixbDeploy] target is required")
    rejects(config({ target: { host: "203.0.113.10" } }), "target is not a deploy target")
  })

  test("names settings it does not know, and where a moved one went", () => {
    rejects(config({ host: "203.0.113.10" }), "Unknown deploy setting 'host'")
    rejects(
      config({ services: { api: { port: 3012 } } }),
      "Ports belong to the target, such as `new SshTarget({ ports: { api: 3012 } })`."
    )
    rejects(config({ services: { sentinel: true } }), "Unknown deploy setting 'services.sentinel'")
  })

  test("runs HTTP and single-instance services as one process", () => {
    rejects(
      config({ services: { api: { process: { instances: 2 } } } }),
      "HTTP services run one process each."
    )
    rejects(
      config({ services: { scheduler: { process: { instances: 2 } } } }),
      "The scheduler runs exactly one process"
    )
  })

  test("checks names and domains", () => {
    rejects(config({ name: "Northline" }), "name must use lowercase letters")
    rejects(config({ name: "northline-" }), "name must use lowercase letters")
    rejects(config({ domain: "https://example.com" }), "domain must be a hostname")
    rejects(
      config({ services: { app: { domain: "bad_host.example.com" } } }),
      "services.app.domain must be a valid hostname"
    )
  })

  test("checks worker types and concurrency", () => {
    rejects(config({ services: { workers: { types: [] } } }), "non-empty list of worker types")
    rejects(
      config({ services: { workers: { types: ["sync", "sentinel"] } } }),
      'unknown worker type "sentinel"'
    )
    rejects(
      config({ services: { workers: { types: ["sync", "sync"] } } }),
      "lists sync more than once"
    )
    rejects(
      config({ services: { workers: { concurrency: { action: 2 } } } }),
      "action jobs run one at a time"
    )
    rejects(
      config({ services: { workers: { concurrency: { agent: 0 } } } }),
      "services.workers.concurrency.agent must be a positive integer"
    )
  })

  test("checks environment variables", () => {
    rejects(config({ env: { "bad-name": "1" } }), "env.bad-name is not a valid environment")
    rejects(config({ env: { PORT: 3000 } }), "env.PORT must be a string")
  })

  test("keeps project processes inside the project and off service names", () => {
    const process = (definition: unknown) => config({ processes: { watcher: definition } })

    rejects(config({ processes: { api: { entrypoint: "api.ts" } } }), "uses the name of a Sixb")
    rejects(process({ entrypoint: "../outside.ts" }), "must be a path inside the project")
    rejects(process({ entrypoint: "/usr/bin/env" }), "must be a path inside the project")
    rejects(process({ entrypoint: "watch.ts", args: [1] }), "args must be an array of strings")
    rejects(
      process({ entrypoint: "watch.ts", process: { maxMemory: "lots" } }),
      'maxMemory must be a size such as "512M"'
    )
  })

  test("exposes only the authoring helper at runtime", () => {
    expect(Object.keys(deploy)).toEqual(["defineDeploy"])
  })
})
