import type { Sandbox, SandboxFactory } from "@sixb/core/sandboxes"
import { BoxdSandboxFactory, type BoxdSandboxFactoryOptions } from "../src"

/**
 * Live tests run against real boxd machines when SIXB_BOXD_E2E=1. They read the API key from
 * BOXD_API_KEY and, when set, the organization from BOXD_ORG and the region from BOXD_REGION.
 * Machines are named with SIXB_BOXD_E2E_PREFIX (default "sixb-e2e-") and labelled
 * `sixb-e2e=1`. Each test destroys the sandboxes it creates.
 */
export const liveEnabled = process.env.SIXB_BOXD_E2E === "1"

export const LIVE_TIMEOUT_MS = 300_000

export function liveOptions(
  options: Partial<BoxdSandboxFactoryOptions> = {}
): BoxdSandboxFactoryOptions {
  // Explicit, never the SDK's fallback: inside a boxd machine that is the machine's own login.
  const apiKey = process.env.BOXD_API_KEY
  if (!apiKey) throw new Error("SIXB_BOXD_E2E=1 needs BOXD_API_KEY")
  return {
    apiKey,
    ...(process.env.BOXD_ORG ? { org: process.env.BOXD_ORG } : {}),
    ...(process.env.BOXD_REGION ? { region: process.env.BOXD_REGION } : {}),
    namePrefix: process.env.SIXB_BOXD_E2E_PREFIX ?? "sixb-e2e-",
    labels: { "sixb-e2e": "1" },
    ...options,
  }
}

/** Log each machine a factory creates, so a failed run's machines can be found and removed. */
export function logged<T extends SandboxFactory>(factory: T): T {
  const create = factory.create.bind(factory)
  const resume = factory.resume?.bind(factory)
  return Object.assign(Object.create(factory), {
    async create(options?: Parameters<SandboxFactory["create"]>[0]): Promise<Sandbox> {
      const sandbox = await create(options)
      console.log(`[BoxdE2E] created machine ${sandbox.id}`)
      return sandbox
    },
    ...(resume
      ? {
          async resume(
            name: string,
            options?: Parameters<NonNullable<SandboxFactory["resume"]>>[1]
          ) {
            const sandbox = await resume(name, options)
            console.log(`[BoxdE2E] resumed machine ${sandbox.id}`)
            return sandbox
          },
        }
      : {}),
  }) as T
}

export function liveFactory(options: Partial<BoxdSandboxFactoryOptions> = {}): BoxdSandboxFactory {
  return logged(new BoxdSandboxFactory(liveOptions(options)))
}
