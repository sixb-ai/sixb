import { describe, expect, test } from "bun:test"
import { InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { SixbCliError } from "../src/lib/errors"
import type { LoadedSixb } from "../src/lib/loadSixb"
import type { ProductionRole } from "../src/lib/production-roles"
import { assertShareableProviders } from "../src/lib/shareable-providers"

function sixbWith(providers: { broker?: unknown; queues?: unknown }): LoadedSixb {
  return {
    id: "test",
    broker: providers.broker ?? new SharedBroker(),
    queues: providers.queues ?? new SharedQueues(),
  } as unknown as LoadedSixb
}

// Stand-ins that are shareable as far as the guard can tell: not `InMemory*`, no
// `processLocal`. This is the same escape hatch the CLI's own role fixtures use.
class SharedBroker {}
class SharedQueues {}

/** A third-party provider that is honest about being process-local. */
class DeclaredProcessLocalQueues {
  readonly processLocal = true as const
}

const EVENT_PLANE_ROLES: readonly ProductionRole[] = [
  "api",
  "rules",
  "scheduler",
  "orchestrator",
  "worker",
  "worker-group",
]

describe("assertShareableProviders", () => {
  test("refuses in-memory queues in every role that touches the event plane", () => {
    for (const role of EVENT_PLANE_ROLES) {
      expect(
        () => assertShareableProviders(sixbWith({ queues: new InMemoryQueues() }), role),
        role
      ).toThrow(/requires a queues provider that can be shared across processes/)
    }
  })

  test("refuses an in-memory broker too, which no role used to check", () => {
    for (const role of EVENT_PLANE_ROLES) {
      expect(
        () => assertShareableProviders(sixbWith({ broker: new InMemoryBroker() }), role),
        role
      ).toThrow(/requires a broker provider that can be shared across processes/)
    }
  })

  test("carries the replacement as a remediation, not buried in the diagnosis", () => {
    // The terminal gives a remediation its own place, so a reader is not left to find the
    // instruction inside a paragraph that also explains the failure.
    const queuesFailure = expectSixbCliError(() =>
      assertShareableProviders(sixbWith({ queues: new InMemoryQueues() }), "worker")
    )
    expect(queuesFailure.remediation).toContain("@sixb/bullmq")
    expect(queuesFailure.message).not.toContain("@sixb/bullmq")

    const brokerFailure = expectSixbCliError(() =>
      assertShareableProviders(sixbWith({ broker: new InMemoryBroker() }), "api")
    )
    expect(brokerFailure.remediation).toContain("@sixb/redis or @sixb/nats")
  })

  test("honours the declared marker, for providers `instanceof` cannot see", () => {
    // Two copies of @sixb/core in one dependency graph defeat `instanceof`, and a
    // hand-written double never extends our class at all.
    expect(() =>
      assertShareableProviders(sixbWith({ queues: new DeclaredProcessLocalQueues() }), "worker")
    ).toThrow(/requires a queues provider/)
  })

  test("lets UI-only roles through", () => {
    // `atlas` and `app` read auth.isEnabled() and the project id off the runtime and
    // never publish or claim, so refusing to boot would block a valid UI container.
    for (const role of ["atlas", "app"] as const) {
      expect(() =>
        assertShareableProviders(
          sixbWith({ broker: new InMemoryBroker(), queues: new InMemoryQueues() }),
          role
        )
      ).not.toThrow()
    }
  })

  test("accepts providers that are shareable", () => {
    for (const role of EVENT_PLANE_ROLES) {
      expect(() => assertShareableProviders(sixbWith({}), role), role).not.toThrow()
    }
  })
})

function expectSixbCliError(run: () => void): SixbCliError {
  try {
    run()
  } catch (error) {
    if (error instanceof SixbCliError) return error
    throw error
  }
  throw new Error("Expected the call to throw a SixbCliError.")
}
