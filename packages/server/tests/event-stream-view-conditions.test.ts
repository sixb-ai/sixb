import { afterEach, expect, jest, test } from "bun:test"
import {
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  prop,
  SixbHost,
  type StoredDomainEvent,
} from "../../core/src"
import { createTestSixb } from "../../core/src/testing"
import { resolveRolesWithConditions } from "../../core/tests/helpers/view-conditions"
import { createTestRuntimeDeps, waitFor } from "../../core/tests/test-runtime-deps"
import { SubscriptionHub } from "../src/routes/ws/subscription-hub"

// The event stream hands each batch to the reader's `events.visible`, as routes/ws/events.ts does.
// What a view condition hides is left out of the batch: the socket keeps streaming.

const projectId = "event-stream-view-conditions"

const Ticket = defineObjectType({
  id: "ticket",
  name: "Ticket",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string", { query: { searchable: true, filterable: true } }),
  ],
})

const openTickets = defineRole("open-tickets", {
  grantedTo: [defineGroup("open")],
  grants: [can.view(Ticket).where((ticket) => ticket.p.status.eq("open"))],
})

// A fake-timer test that times out never reaches its own `finally`.
afterEach(() => jest.useRealTimers())

// Reproduce: make core's events/view-conditions.ts throw on an object event it hides, and the
// stream closes at the batch; return true for it instead, and the closed ticket is delivered.
test("the event stream skips what a view condition hides, and keeps streaming", async () => {
  const host = new SixbHost({ id: projectId, ontology: [Ticket], ...createTestRuntimeDeps() })
  const trusted = createTestSixb(host)
  const { contextFor } = resolveRolesWithConditions({ ontology: [Ticket], roles: [openTickets] })
  const reader = createTestSixb(host, { authorization: contextFor(["open"]) })

  await trusted.objects(Ticket).upsert({ properties: { id: "t-closed", status: "closed" } })
  await trusted.objects(Ticket).upsert({ properties: { id: "t-open", status: "open" } })
  const log = await waitFor(
    () => host.events.read(),
    (events) => events.length === 2
  )
  const closed = log.find(
    (event) => event.topic === "objects" && event.payload.primaryId === "t-closed"
  )
  const open = log.find(
    (event) => event.topic === "objects" && event.payload.primaryId === "t-open"
  )
  if (!closed || !open) throw new Error("[Test] Expected both tickets' creation.")

  jest.useFakeTimers()
  const { deliver, hub } = createManualHub()
  const socket = new TestEventSocket()

  try {
    await hub.subscribe(
      {},
      socket,
      { matches: () => true, view: (batch) => reader.events.visible(batch) },
      () => undefined
    )

    deliver([closed])
    deliver([open])
    await advanceUntil(() => socket.events.length > 0 || socket.closeCode !== undefined)

    expect(socket.events).toEqual(["t-open"])
    expect(socket.closeCode).toBeUndefined()
  } finally {
    await hub.close()
  }
})

class TestEventSocket {
  readonly events: string[] = []
  closeCode: number | undefined

  send(message: string): void {
    const frame = JSON.parse(message) as { readonly event?: StoredDomainEvent }
    if (frame.event?.topic === "objects") this.events.push(frame.event.payload.primaryId)
  }

  close(code?: number): void {
    this.closeCode = code
  }
}

/** A hub over a source whose events the test delivers itself, framed as the event stream does. */
function createManualHub() {
  let deliverTo: ((events: readonly StoredDomainEvent[]) => void) | undefined
  const hub = new SubscriptionHub<StoredDomainEvent>({
    subscribe: async (deliver) => {
      deliverTo = deliver
      return () => {
        deliverTo = undefined
      }
    },
    frames: (batch) => batch.map((event) => ({ type: "event", event })),
    expired: async () => ({ type: "expired" }),
  })

  return {
    deliver: (events: readonly StoredDomainEvent[]) => {
      if (!deliverTo) throw new Error("[Test] The hub is not subscribed.")
      deliverTo(events)
    },
    hub,
  }
}

/** Advances fake time one flush delay at a time, letting the hub and the view run between steps. */
async function advanceUntil(condition: () => boolean): Promise<void> {
  for (let step = 0; !condition(); step += 1) {
    if (step === 1_000) throw new Error("[Test] Timed out waiting for the hub")
    jest.advanceTimersByTime(10)
    await new Promise((resolve) => setImmediate(resolve))
  }
}
