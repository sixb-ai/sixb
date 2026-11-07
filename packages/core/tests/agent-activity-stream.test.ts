import { afterEach, expect, setSystemTime, test } from "bun:test"
import { InMemoryBroker } from "../src"
import {
  AGENT_ACTIVITY_STREAM_ID,
  publishAgentComputerActivity,
  publishAgentThreadMoved,
} from "../src/agents/streams/protocol"

afterEach(() => {
  setSystemTime()
})

async function activity(broker: InMemoryBroker) {
  const { records } = await broker.read({
    projectId: "project",
    streamId: AGENT_ACTIVITY_STREAM_ID,
  })
  return records
}

// Reproduce: build the idempotency key from `occurredAt`; a broker takes the second announcement
// of a millisecond for a retry of the first, and the web misses it.
test("two announcements in one millisecond are two announcements", async () => {
  setSystemTime(new Date("2026-11-07T12:00:00.000Z"))
  const broker = new InMemoryBroker()
  const ownerPrincipal = { type: "user", id: "ava" }
  const computer = { projectId: "project", ownerPrincipal, computerId: "laptop", folder: "/q3" }
  const moved = { projectId: "project", ownerPrincipal, threadId: "t1" }

  await publishAgentComputerActivity(broker, { ...computer, online: true })
  await publishAgentComputerActivity(broker, { ...computer, online: true })
  await publishAgentThreadMoved(broker, moved)
  await publishAgentThreadMoved(broker, moved)

  expect(await activity(broker)).toHaveLength(4)
})
