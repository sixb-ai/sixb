import { describe, expect, test } from "bun:test"
import { InMemoryBroker } from "../src"
import { createBrokerStreamSink } from "../src/agents/run-events"
import {
  type AgentRunStreamEvent,
  agentRunStepsStreamId,
  agentRunStreamId,
  isAgentRunStreamEvent,
} from "../src/agents/streams/protocol"
import { coveredBySteps, readAgentRunSteps } from "../src/agents/streams/steps"
import type { ModelUiChunk } from "../src/models/events"
import type { ConversationAgentRunRecord } from "../src/storage"

const projectId = "stream-steps-tests"

function runRecord(
  overrides: Partial<ConversationAgentRunRecord> = {}
): ConversationAgentRunRecord {
  return {
    kind: "conversation",
    id: "agt_run_steps",
    projectId,
    executionId: "exec_agt_run_steps",
    threadId: "agt_thr_steps",
    triggerMessageId: "agt_msg_steps",
    status: "running",
    attempt: 1,
    createdAt: new Date("2026-01-02T03:00:00.000Z"),
    ...overrides,
  }
}

async function liveEvents(broker: InMemoryBroker, runId = "agt_run_steps") {
  const page = await broker.read({ projectId, streamId: agentRunStreamId(runId), limit: 10_000 })
  return page.records.map((record) => record.payload as unknown as AgentRunStreamEvent)
}

function liveChunks(events: readonly AgentRunStreamEvent[]): ModelUiChunk[] {
  return events.flatMap((event) => (event.type === "agent.ui.chunk" ? [event.chunk] : []))
}

const steer = {
  id: "agt_msg_steer",
  authorPrincipal: { type: "user" as const, id: "usr_mina" },
  parts: [{ type: "text" as const, text: "Use the Q3 numbers" }],
  createdAt: "2026-01-02T03:01:00.000Z",
}

function sinkWith(broker: InMemoryBroker, deltaWindowMs = 50) {
  return createBrokerStreamSink({ broker, projectId, deltaWindowMs })
}

describe("agent run stream deltas", () => {
  test("go out as one record per span within the window, in order with what follows", async () => {
    const broker = new InMemoryBroker()
    const sink = sinkWith(broker, 60_000)
    const run = runRecord()
    let chunkIndex = 0
    const publish = (chunk: ModelUiChunk) =>
      sink.publishUiChunk({ run, chunkIndex: chunkIndex++, chunk })

    await publish({ type: "start-step" })
    for (const delta of ["Hel", "lo", ", ", "world"])
      await publish({ type: "text-delta", id: "t", delta })
    for (const inputTextDelta of ['{"co', 'mmand"', ':"ls"}']) {
      await publish({
        type: "tool-input-delta",
        toolCallId: "c1",
        toolName: "bash",
        inputTextDelta,
      })
    }
    await publish({
      type: "tool-input-available",
      toolCallId: "c1",
      toolName: "bash",
      input: { command: "ls" },
    })

    const events = await liveEvents(broker)
    expect(liveChunks(events)).toEqual([
      { type: "start-step" },
      { type: "text-delta", id: "t", delta: "Hello, world" },
      {
        type: "tool-input-delta",
        toolCallId: "c1",
        toolName: "bash",
        inputTextDelta: '{"command":"ls"}',
      },
      {
        type: "tool-input-available",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "ls" },
      },
    ])
    // A merged record keeps its first delta's index: indices stay unique and ordered.
    expect(
      events.map((event) => (event.type === "agent.ui.chunk" ? event.chunkIndex : null))
    ).toEqual([0, 1, 5, 8])
  })

  test("held at the end of a burst go out once the window passes", async () => {
    const broker = new InMemoryBroker()
    const sink = sinkWith(broker, 20)
    const run = runRecord()

    await sink.publishUiChunk({
      run,
      chunkIndex: 0,
      chunk: { type: "text-delta", id: "t", delta: "a" },
    })
    await sink.publishUiChunk({
      run,
      chunkIndex: 1,
      chunk: { type: "text-delta", id: "t", delta: "b" },
    })
    expect(liveChunks(await liveEvents(broker))).toEqual([])

    await Bun.sleep(60)
    expect(liveChunks(await liveEvents(broker))).toEqual([
      { type: "text-delta", id: "t", delta: "ab" },
    ])
  })

  test("held when the run ends go out before its end", async () => {
    const broker = new InMemoryBroker()
    const sink = sinkWith(broker, 60_000)
    const run = runRecord()

    await sink.publishUiChunk({
      run,
      chunkIndex: 0,
      chunk: { type: "text-delta", id: "t", delta: "done" },
    })
    await sink.publishRunFinished({ ...run, status: "succeeded", finishReason: "stop" })

    expect((await liveEvents(broker)).map((event) => event.type)).toEqual([
      "agent.ui.chunk",
      "agent.run.finished",
    ])
  })
})

describe("agent run finished steps", () => {
  test("are logged as each next step starts, and cover the live chunks they hold", async () => {
    const broker = new InMemoryBroker()
    const sink = sinkWith(broker, 0)
    const run = runRecord()
    let chunkIndex = 0
    const publish = (chunk: ModelUiChunk) =>
      sink.publishUiChunk({ run, chunkIndex: chunkIndex++, chunk })

    await publish({ type: "start-step" })
    await publish({ type: "reasoning-start", id: "r" })
    for (const delta of ["thi", "nk"]) await publish({ type: "reasoning-delta", id: "r", delta })
    await publish({ type: "reasoning-end", id: "r" })
    await publish({ type: "tool-input-start", toolCallId: "c1", toolName: "spawn_agent" })
    await publish({
      type: "tool-input-available",
      toolCallId: "c1",
      toolName: "spawn_agent",
      input: { task: "x" },
    })
    await publish({
      type: "tool-output-available",
      toolCallId: "c1",
      toolName: "spawn_agent",
      output: { id: "child" },
    })
    // The second step starts: the first is finished.
    await publish({ type: "start-step" })
    await publish({ type: "text-delta", id: "t", delta: "now" })

    const steps = await readAgentRunSteps(broker, { projectId, runId: run.id, attempt: 1 })
    expect(steps).not.toBeNull()
    expect(isAgentRunStreamEvent(steps)).toBe(true)
    expect(steps?.throughChunkIndex).toBe(7)
    expect(steps?.chunks).toEqual([
      { type: "start-step" },
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", delta: "think" },
      { type: "reasoning-end", id: "r" },
      { type: "tool-input-start", toolCallId: "c1", toolName: "spawn_agent" },
      {
        type: "tool-input-available",
        toolCallId: "c1",
        toolName: "spawn_agent",
        input: { task: "x" },
      },
      {
        type: "tool-output-available",
        toolCallId: "c1",
        toolName: "spawn_agent",
        output: { id: "child" },
      },
    ])

    // The live chunks after them are the ones a late reader still needs.
    const events = await liveEvents(broker)
    const uncovered = events.filter((event) => steps && !coveredBySteps(steps, event))
    expect(liveChunks(uncovered)).toEqual([
      { type: "start-step" },
      { type: "text-delta", id: "t", delta: "now" },
    ])
  })

  test("leave out what a step asked again dropped", async () => {
    const broker = new InMemoryBroker()
    const sink = sinkWith(broker, 0)
    const run = runRecord()
    let chunkIndex = 0
    const publish = (chunk: ModelUiChunk) =>
      sink.publishUiChunk({ run, chunkIndex: chunkIndex++, chunk })

    await publish({ type: "start-step" })
    await publish({ type: "text-delta", id: "t", delta: "first try" })
    await publish({ type: "start-step", retry: true })
    await publish({ type: "text-delta", id: "t", delta: "second try" })
    await publish({ type: "start-step" })

    const steps = await readAgentRunSteps(broker, { projectId, runId: run.id, attempt: 1 })
    expect(steps?.chunks).toEqual([
      { type: "start-step" },
      { type: "text-delta", id: "t", delta: "second try" },
    ])
    expect(steps?.throughChunkIndex).toBe(3)
  })

  test("of an earlier attempt are not read for a later one", async () => {
    const broker = new InMemoryBroker()
    const sink = sinkWith(broker, 0)
    const first = runRecord({ attempt: 1 })
    await sink.publishUiChunk({ run: first, chunkIndex: 0, chunk: { type: "start-step" } })
    await sink.publishUiChunk({
      run: first,
      chunkIndex: 1,
      chunk: { type: "text-delta", id: "t", delta: "old" },
    })
    await sink.publishUiChunk({ run: first, chunkIndex: 2, chunk: { type: "start-step" } })

    const second = runRecord({ attempt: 2 })
    await sink.publishUiChunk({ run: second, chunkIndex: 0, chunk: { type: "start-step" } })
    await sink.publishUiChunk({
      run: second,
      chunkIndex: 1,
      chunk: { type: "text-delta", id: "t", delta: "new" },
    })
    await sink.publishUiChunk({ run: second, chunkIndex: 2, chunk: { type: "start-step" } })

    const page = await broker.read({ projectId, streamId: agentRunStepsStreamId(first.id) })
    expect(page.records).toHaveLength(2)
    expect(
      (await readAgentRunSteps(broker, { projectId, runId: first.id, attempt: 2 }))?.chunks
    ).toEqual([{ type: "start-step" }, { type: "text-delta", id: "t", delta: "new" }])
  })

  // Removal proof: publish the read straight to the broker in `publishInboxRead`, outside the run's
  // chain; it then lands before the deltas still held.
  test("keep a read after the deltas held before it", async () => {
    const broker = new InMemoryBroker()
    const sink = sinkWith(broker, 60_000)
    const run = runRecord()

    await sink.publishUiChunk({ run, chunkIndex: 0, chunk: { type: "start-step" } })
    await sink.publishUiChunk({
      run,
      chunkIndex: 1,
      chunk: { type: "text-delta", id: "t", delta: "Q2 shows a dip." },
    })
    await sink.publishInboxRead({ run, messages: [steer] })

    const events = await liveEvents(broker)
    expect(events.map((event) => event.type)).toEqual([
      "agent.ui.chunk",
      "agent.ui.chunk",
      "agent.inbox.read",
    ])
    expect(events[2]).toMatchObject({ afterChunkIndex: 1 })
  })

  // Removal proof: drop `reads` from the logged step, or the `agent.inbox.read` case from
  // `coveredBySteps`; a late reader then gets the read after every finished step.
  test("hold what the turn read where it read it, and cover its live record", async () => {
    const broker = new InMemoryBroker()
    const sink = sinkWith(broker, 0)
    const run = runRecord()
    let chunkIndex = 0
    const publish = (chunk: ModelUiChunk) =>
      sink.publishUiChunk({ run, chunkIndex: chunkIndex++, chunk })

    await publish({ type: "start-step" })
    await publish({ type: "text-delta", id: "a", delta: "Q2 shows a dip." })
    await publish({ type: "start-step" })
    // The model loop reads the inbox once the step started, before its call streams.
    await sink.publishInboxRead({ run, messages: [steer] })
    await publish({ type: "text-delta", id: "a", delta: "With Q3" })
    await publish({ type: "start-step" })
    await publish({ type: "text-delta", id: "a", delta: "now" })

    const steps = await readAgentRunSteps(broker, { projectId, runId: run.id, attempt: 1 })
    expect(steps?.chunks).toEqual([
      { type: "start-step" },
      { type: "text-delta", id: "a", delta: "Q2 shows a dip." },
      { type: "start-step" },
      { type: "text-delta", id: "a", delta: "With Q3" },
    ])
    expect(steps?.reads).toEqual([{ at: 3, messages: [steer] }])
    expect(isAgentRunStreamEvent(steps)).toBe(true)

    const events = await liveEvents(broker)
    const uncovered = events.filter((event) => steps && !coveredBySteps(steps, event))
    expect(uncovered.map((event) => event.type)).toEqual(["agent.ui.chunk", "agent.ui.chunk"])
  })

  test("rebuild a turn its live stream outgrew", async () => {
    const broker = new InMemoryBroker()
    const sink = sinkWith(broker, 0)
    const run = runRecord()
    let chunkIndex = 0
    const expected: string[] = []
    // Three steps of 2,500 deltas: the live stream keeps the newest 5,000 records only.
    for (let step = 0; step < 3; step += 1) {
      await sink.publishUiChunk({ run, chunkIndex: chunkIndex++, chunk: { type: "start-step" } })
      for (let index = 0; index < 2_500; index += 1) {
        const delta = `${step}.${index} `
        expected.push(delta)
        await sink.publishUiChunk({
          run,
          chunkIndex: chunkIndex++,
          chunk: { type: "text-delta", id: "t", delta },
        })
      }
    }

    const events = await liveEvents(broker)
    expect(events).toHaveLength(5_000)
    expect(liveChunks(events)[0]).not.toEqual({ type: "start-step" })

    const steps = await readAgentRunSteps(broker, { projectId, runId: run.id, attempt: 1 })
    if (!steps) throw new Error("expected finished steps")
    const rebuilt = [
      ...steps.chunks,
      ...liveChunks(events.filter((event) => !coveredBySteps(steps, event))),
    ]
    const text = rebuilt.map((chunk) => (chunk.type === "text-delta" ? chunk.delta : "")).join("")
    expect(text).toBe(expected.join(""))
  })
})
