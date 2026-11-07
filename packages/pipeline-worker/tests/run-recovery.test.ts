import { describe, expect, setSystemTime, test } from "bun:test"
import {
  col,
  type DatasetRow,
  defineDataset,
  definePipeline,
  definePipelineStep,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type PipelineDefinition,
  SixbHost,
} from "@sixb/core"
import { RecoveryGate, runRunRecoveryContractSuite } from "@sixb/core/testing"
import { PipelineWorker } from "../src"

const projectId = "pipeline-recovery"
const runId = "run-1"
const LEASE_MS = 15 * 60_000

const raw = defineDataset("raw", { schema: [col("id", "string")] })
const cleaned = defineDataset("cleaned", { schema: [col("id", "string")] })
const published = defineDataset("published", { schema: [col("id", "string")] })
const audited = defineDataset("audited", { schema: [col("id", "string")] })

/** Tells a test when a delivery has nothing left to do, which `stop` would otherwise decide for it. */
class WatchedPipelineWorker extends PipelineWorker {
  ended: Promise<void> = Promise.resolve()

  protected override execute(...args: Parameters<PipelineWorker["execute"]>): Promise<void> {
    const execution = super.execute(...args)
    this.ended = execution.then(
      () => {},
      () => {}
    )
    return execution
  }
}

async function createHost(pipeline: PipelineDefinition) {
  const lakeStorage = new InMemoryLakeStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage,
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    datasets: [raw, cleaned, published],
    pipelines: [pipeline],
  })

  await lakeStorage.createDataset(raw)
  const seed = await lakeStorage.beginWrite({ dataset: raw, mode: "snapshot" })
  await seed.writeRows([{ id: "row-1" }, { id: "row-2" }])
  await seed.commit()

  return host
}

/** The same project, after a deploy that changed its pipeline. */
function createDeployedHost(host: SixbHost, pipeline: PipelineDefinition) {
  return new SixbHost({
    id: projectId,
    ontology: [],
    broker: new InMemoryBroker(),
    storage: host.storage,
    lakeStorage: host.lakeStorage,
    blobStorage: new InMemoryBlobStorage(),
    queues: host.queues,
    datasets: [raw, cleaned, published, audited],
    pipelines: [pipeline],
  })
}

async function queueRun(host: SixbHost, id = runId) {
  await host.storage.executions.create({
    id: `exec:${id}`,
    projectId,
    executor: { type: "primitive", kind: "pipeline", runId: id },
    source: { type: "schedule", eventId: `event:${id}` },
    correlationId: `correlation:${id}`,
    authorizationRef: {
      type: "trustedPrimitive",
      primitive: { kind: "pipeline", id: "customers", runId: id },
    },
  })
  await host.storage.pipelineRuns!.queue({
    id,
    projectId,
    executionId: `exec:${id}`,
    pipelineId: "customers",
  })
  await host.queues.pipelines.enqueue({
    projectId,
    jobs: [{ id, type: "pipeline.run.requested", payload: { runId: id } }],
  })
}

async function readRows(host: SixbHost, datasetId: string): Promise<DatasetRow[]> {
  if (!(await host.lakeStorage.getLatestVersion(datasetId))) return []

  const rows: DatasetRow[] = []
  for await (const row of host.lakeStorage.readRows({ datasetId })) rows.push(row)
  return rows
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await condition())) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

async function runWorkerUntil(host: SixbHost, done: () => boolean | Promise<boolean>) {
  const worker = new PipelineWorker(host)
  await worker.start()
  try {
    await waitFor(done)
  } finally {
    await worker.stop()
  }
}

async function runStatus(host: SixbHost): Promise<string | undefined> {
  return (await host.storage.pipelineRuns!.getById({ projectId, id: runId }))?.status
}

async function runEnded(host: SixbHost): Promise<boolean> {
  const status = await runStatus(host)
  return status !== "queued" && status !== "running"
}

function readSteps(host: SixbHost) {
  return host.storage.pipelineRuns!.listSteps({ projectId, pipelineRunId: runId, order: "asc" })
}

/** Two appending steps that count their starts. A gate holds the second, before its commit. */
function createPipeline(blocked?: RecoveryGate) {
  const starts = { clean: 0, publish: 0 }

  const clean = definePipelineStep("clean")
    .inputs({ raw })
    .output(cleaned, { mode: "append" })
    .run(async ({ inputs, output }) => {
      starts.clean += 1
      await output.writeRows(inputs.raw.readRows())
    })

  const publish = definePipelineStep("publish")
    .inputs({ cleaned })
    .output(published, { mode: "append" })
    .run(async ({ inputs, output, signal }) => {
      starts.publish += 1
      await output.writeRows(inputs.cleaned.readRows())
      await blocked?.wait(signal)
    })

  return { pipeline: definePipeline("customers").then(clean).then(publish), starts }
}

runRunRecoveryContractSuite("Pipeline", async () => {
  const gate = new RecoveryGate()
  const { pipeline, starts } = createPipeline(gate)

  const host = await createHost(pipeline)
  const first = new WatchedPipelineWorker(host)

  let jobsSettled = 0
  const queue = host.queues.pipelines
  const retry = queue.retry.bind(queue)
  queue.retry = async (input) => {
    jobsSettled += 1
    return retry(input)
  }

  return {
    afterCrash: "resumes",
    afterShutdown: "resumes",
    leaseMs: LEASE_MS,

    async begin() {
      await queueRun(host)
      await first.start()
      await gate.reached
    },
    unblock: () => gate.open(),
    firstExecutionEnded: () => first.ended,
    stop: () => first.stop(),

    redeliver: () => runWorkerUntil(host, async () => (await runStatus(host)) !== "running"),

    async deliverDuplicate() {
      await queue.enqueue({
        projectId,
        jobs: [{ id: `${runId}:join:other`, type: "pipeline.run.requested", payload: { runId } }],
      })
      await runWorkerUntil(host, () => jobsSettled > 0)
    },

    status: async () => String(await runStatus(host)),
    workStarts: () => starts.publish,
    outputCopies: async () => (await readRows(host, published.id)).length / 2,
    dispose: () => first.stop(),
  }
})

describe("PipelineWorker recovery", () => {
  /** Dies right after a lake commit, before anything records it. */
  function dieAfterCommitTo(host: SixbHost, datasetId: string): RecoveryGate {
    const died = new RecoveryGate()
    const beginWrite = host.lakeStorage.beginWrite.bind(host.lakeStorage)

    host.lakeStorage.beginWrite = async (input) => {
      const session = await beginWrite(input)
      if (input.dataset.id !== datasetId) return session

      const commit = session.commit.bind(session)
      session.commit = async (commitInput) => {
        const committed = await commit(commitInput)
        await died.wait()
        return committed
      }
      return session
    }

    return died
  }

  // Drop the lookup in `runStep` to watch the append land twice.
  test("records a step whose commit landed before the crash, without running it again", async () => {
    const { pipeline, starts } = createPipeline()
    const host = await createHost(pipeline)
    await queueRun(host)

    const died = dieAfterCommitTo(host, cleaned.id)
    const dead = new PipelineWorker(host)
    await dead.start()
    await died.reached

    expect((await readSteps(host)).steps).toMatchObject([{ stepId: "clean", status: "running" }])
    expect(await readRows(host, cleaned.id)).toHaveLength(2)

    setSystemTime(new Date(Date.now() + LEASE_MS + 1))
    await runWorkerUntil(host, async () => (await runStatus(host)) === "succeeded")
    setSystemTime()

    expect(starts).toEqual({ clean: 1, publish: 1 })
    expect(await readRows(host, cleaned.id)).toHaveLength(2)
    expect(await readRows(host, published.id)).toHaveLength(2)

    const { steps } = await readSteps(host)
    expect(steps.map((step) => step.status)).toEqual(["succeeded", "succeeded"])

    const committed = await host.events.read({ types: ["dataset.version.committed"] })
    expect(committed).toHaveLength(2)

    died.open()
    await dead.stop()
  })

  // Skip the lookup after a failed commit in `runStep` to watch the next run append these rows again.
  test("a commit that landed and answered with an error is a commit", async () => {
    const { pipeline, starts } = createPipeline()
    const host = await createHost(pipeline)
    await queueRun(host)

    let lost = false
    const beginWrite = host.lakeStorage.beginWrite.bind(host.lakeStorage)
    host.lakeStorage.beginWrite = async (input) => {
      const session = await beginWrite(input)
      if (input.dataset.id !== cleaned.id) return session

      const commit = session.commit.bind(session)
      session.commit = async (commitInput) => {
        const committed = await commit(commitInput)
        if (lost) return committed

        lost = true
        throw new Error("connection lost during COMMIT")
      }
      return session
    }

    await runWorkerUntil(host, () => runEnded(host))

    expect(await runStatus(host)).toBe("succeeded")
    expect(starts).toEqual({ clean: 1, publish: 1 })
    expect(await readRows(host, cleaned.id)).toHaveLength(2)
  })

  // Check `givenUp` before the lookup in `runStep` to watch this commit end up `failed`.
  test("a run out of attempts still records the step that landed, and starts no other", async () => {
    const { pipeline, starts } = createPipeline()
    const host = await createHost(pipeline)
    await queueRun(host)

    const died = dieAfterCommitTo(host, cleaned.id)
    const dead = new PipelineWorker(host)
    await dead.start()
    await died.reached

    setSystemTime(new Date(Date.now() + LEASE_MS + 1))
    for (let crash = 1; crash <= 4; crash += 1) {
      await host.storage.pipelineRuns!.startOrReclaim({
        projectId,
        id: runId,
        execution: { token: `crash-${crash}`, queueLeaseExpiresAt: new Date(0) },
      })
    }

    await runWorkerUntil(host, async () => (await runStatus(host)) !== "running")
    setSystemTime()

    expect(await runStatus(host)).toBe("failed")
    expect(starts).toEqual({ clean: 1, publish: 0 })
    expect(await readRows(host, cleaned.id)).toHaveLength(2)

    const { steps } = await readSteps(host)
    expect(steps).toMatchObject([{ stepId: "clean", status: "succeeded" }])

    died.open()
    await dead.stop()
  })

  /** Stops a run inside its `publish` step, which is where the next deploy finds it. */
  async function stopInPublish(host: SixbHost, gate: RecoveryGate) {
    await queueRun(host)

    const stopped = new PipelineWorker(host)
    await stopped.start()
    await gate.reached
    await stopped.stop()

    gate.open()
  }

  // Key recorded steps by step run id, as it was, to watch `clean` append its rows a second time.
  test("a deploy that inserts a step does not run a committed step again", async () => {
    const gate = new RecoveryGate()
    const before = createPipeline(gate)
    const host = await createHost(before.pipeline)
    await stopInPublish(host, gate)

    const audit = definePipelineStep("audit")
      .inputs({ raw })
      .output(audited, { mode: "snapshot" })
      .run(async ({ inputs, output }) => {
        await output.writeRows(inputs.raw.readRows())
      })
    const [clean, publish] = before.pipeline.graph.nodes.map((node) => node.step)
    const deployed = createDeployedHost(
      host,
      definePipeline("customers").then(audit).then(clean!).then(publish!)
    )

    await runWorkerUntil(deployed, async () => (await runStatus(deployed)) !== "running")

    expect(await runStatus(deployed)).toBe("succeeded")
    expect(before.starts.clean).toBe(1)
    expect(await readRows(deployed, cleaned.id)).toHaveLength(2)

    const { steps } = await readSteps(deployed)
    expect(steps.map(({ stepId, status }) => `${stepId} ${status}`).sort()).toEqual([
      "audit succeeded",
      "clean succeeded",
      "publish succeeded",
    ])
  })

  // Drop `cancelStepsNoLongerDefined` to watch a succeeded run keep a step running for good.
  test("a deploy that removes a step leaves it cancelled, not running", async () => {
    const gate = new RecoveryGate()
    const before = createPipeline(gate)
    const host = await createHost(before.pipeline)
    await stopInPublish(host, gate)

    const [clean] = before.pipeline.graph.nodes.map((node) => node.step)
    const deployed = createDeployedHost(host, definePipeline("customers").then(clean!))

    await runWorkerUntil(deployed, async () => (await runStatus(deployed)) !== "running")

    expect(await runStatus(deployed)).toBe("succeeded")

    const { steps } = await readSteps(deployed)
    expect(steps).toMatchObject([
      { stepId: "clean", status: "succeeded" },
      { stepId: "publish", status: "cancelled" },
    ])
  })

  // Run every step of a resumed run to watch the first one append its rows twice.
  test("resumes at the first step that did not commit", async () => {
    const gate = new RecoveryGate()
    const { pipeline, starts } = createPipeline(gate)
    const host = await createHost(pipeline)
    await queueRun(host)

    const dead = new PipelineWorker(host)
    await dead.start()
    await gate.reached

    setSystemTime(new Date(Date.now() + LEASE_MS + 1))
    await runWorkerUntil(host, async () => (await runStatus(host)) === "succeeded")
    setSystemTime()

    expect(starts).toEqual({ clean: 1, publish: 2 })
    expect(await readRows(host, cleaned.id)).toHaveLength(2)
    expect(await readRows(host, published.id)).toHaveLength(2)

    const run = await host.storage.pipelineRuns!.getById({ projectId, id: runId })
    expect(run?.output?.datasetId).toBe(published.id)
    expect(run?.attempt).toBe(2)

    await dead.stop()
  })

  test("a step that loses the output guard to the commit it was redoing records that commit", async () => {
    const zombie = new RecoveryGate()
    const redo = new RecoveryGate()
    let attempts = 0
    const clean = definePipelineStep("clean")
      .inputs({ raw })
      .output(cleaned, { mode: "append" })
      .run(async ({ inputs, output }) => {
        attempts += 1
        await output.writeRows(inputs.raw.readRows())
        await (attempts === 1 ? zombie : redo).wait()
      })
    const host = await createHost(definePipeline("customers").then(clean))
    await queueRun(host)

    const dead = new WatchedPipelineWorker(host)
    await dead.start()
    await zombie.reached

    setSystemTime(new Date(Date.now() + LEASE_MS + 1))
    const second = new PipelineWorker(host)
    await second.start()
    await redo.reached

    // The first execution wakes up and commits before the redo does.
    zombie.open()
    await dead.ended
    expect(await readRows(host, cleaned.id)).toHaveLength(2)

    redo.open()
    await waitFor(async () => (await runStatus(host)) === "succeeded")
    setSystemTime()

    expect(await readRows(host, cleaned.id)).toHaveLength(2)

    await second.stop()
    await dead.stop()
  })

  test("ends a run whose step failed before the crash, without running that step again", async () => {
    const { pipeline, starts } = createPipeline()
    const host = await createHost(pipeline)
    await queueRun(host)

    const pipelineRuns = host.storage.pipelineRuns!
    const expired = { token: "dead", queueLeaseExpiresAt: new Date(0) }
    await pipelineRuns.startOrReclaim({ projectId, id: runId, execution: expired })
    await pipelineRuns.startStep({
      projectId,
      id: `${runId}:step:1:clean`,
      executionToken: "dead",
      pipelineRunId: runId,
      pipelineId: "customers",
      stepId: "clean",
      datasetId: cleaned.id,
      mode: "append",
      inputs: [],
    })
    await pipelineRuns.finishStep({
      projectId,
      id: `${runId}:step:1:clean`,
      executionToken: "dead",
      status: "failed",
      error: {
        code: "pipeline.step_failed",
        message: "The source was refused.",
        retryable: false,
        at: "2026-11-07T00:00:00.000Z",
      },
    })

    await runWorkerUntil(host, async () => (await runStatus(host)) !== "running")

    expect(await runStatus(host)).toBe("failed")
    expect(starts).toEqual({ clean: 0, publish: 0 })
  })

  test("a run given up on is failed, with the step it left running", async () => {
    const { pipeline } = createPipeline()
    const host = await createHost(pipeline)
    await queueRun(host)

    const pipelineRuns = host.storage.pipelineRuns!
    for (let crash = 1; crash <= 5; crash += 1) {
      await pipelineRuns.startOrReclaim({
        projectId,
        id: runId,
        execution: { token: `crash-${crash}`, queueLeaseExpiresAt: new Date(0) },
      })
    }
    await pipelineRuns.startStep({
      projectId,
      id: `${runId}:step:1:clean`,
      executionToken: "crash-5",
      pipelineRunId: runId,
      pipelineId: "customers",
      stepId: "clean",
      datasetId: cleaned.id,
      mode: "append",
      inputs: [],
    })

    await runWorkerUntil(host, async () => (await runStatus(host)) === "failed")

    const [finished] = await host.events.read({ types: ["pipeline.run.finished"] })
    expect(finished?.payload).toMatchObject({ runId, status: "failed" })
    expect((await readSteps(host)).steps).toMatchObject([{ stepId: "clean", status: "failed" }])
  })
})
