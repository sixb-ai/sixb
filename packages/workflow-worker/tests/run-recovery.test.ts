import { expect, setSystemTime, test } from "bun:test"
import {
  defineWorkflow,
  defineWorkflowStep,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { republishLostRuns } from "@sixb/core/internal/workers"
import { createTestSixb, RecoveryGate, runRunRecoveryContractSuite } from "@sixb/core/testing"
import { WorkflowWorker } from "../src"

const runId = "wfrun_recovery"
const LEASE_MS = 15 * 60_000
const RETRY_BACKOFF_MS = 1_000

/** Tells a test when a delivery has nothing left to do, which `stop` would otherwise decide for it. */
class WatchedWorkflowWorker extends WorkflowWorker {
  ended: Promise<void> = Promise.resolve()

  protected override execute(...args: Parameters<WorkflowWorker["execute"]>): Promise<void> {
    const execution = super.execute(...args)
    this.ended = execution.then(
      () => {},
      () => {}
    )
    return execution
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await condition())) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

runRunRecoveryContractSuite("Workflow", async () => {
  const gate = new RecoveryGate()
  let starts = 0

  const prepare = defineWorkflowStep("prepare")
    .input({})
    .output({})
    .run(() => ({}))
  const decide = defineWorkflowStep("decide")
    .input({})
    .output({})
    .run(async () => {
      starts += 1
      await gate.wait()
      return {}
    })
  const workflow = defineWorkflow("recovering").input({}).then(prepare).then(decide)

  const host = new SixbHost({
    id: "workflow-recovery",
    ontology: [],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    workflows: [workflow],
  })
  const workflowRuns = host.storage.workflowRuns!
  const readRun = () => workflowRuns.getById({ projectId: host.id, id: runId })

  const first = new WatchedWorkflowWorker(host)

  const runWorkerUntilOver = async () => {
    const worker = new WorkflowWorker(host)
    await worker.start()
    try {
      await waitFor(async () => (await readRun())?.status !== "running")
    } finally {
      await worker.stop()
    }
  }

  return {
    afterCrash: "resumes",
    afterShutdown: "resumes",
    leaseMs: LEASE_MS,

    async begin() {
      await createTestSixb(host).workflows.requestById({
        workflowId: workflow.id,
        runId,
        input: {},
      })
      await first.start()
      await gate.reached
    },
    unblock: () => gate.open(),
    firstExecutionEnded: () => first.ended,

    // The step ignores the stop, as a step is free to: it ends when the test lets it.
    async stop() {
      const stopping = first.stop()
      gate.open()
      await stopping
    },

    async redeliver() {
      setSystemTime(new Date(Date.now() + RETRY_BACKOFF_MS))
      await runWorkerUntilOver()
    },

    async deliverDuplicate() {
      const held = new Promise<void>((resolve) => {
        const retry = host.queues.workflows.retry.bind(host.queues.workflows)
        host.queues.workflows.retry = async (input) => {
          await retry(input)
          resolve()
        }
      })
      await host.queues.workflows.enqueue({
        projectId: host.id,
        jobs: [
          {
            id: `${runId}:duplicate`,
            type: "workflow.run.requested",
            payload: { runId },
          },
        ],
      })

      const worker = new WorkflowWorker(host)
      await worker.start()
      await held
      await worker.stop()
    },

    status: async () => String((await readRun())?.status),
    workStarts: () => starts,

    async outputCopies() {
      const { nodes } = await workflowRuns.nodes.list({
        projectId: host.id,
        workflowRunId: runId,
        statuses: ["succeeded"],
      })
      return nodes.filter((node) => node.nodeKey === "decide").length
    },
    dispose: () => first.stop(),
  }
})

// A job without a stable id: publish a run's job with a fresh id to watch this claim two.
test("a manual run keeps one job however often it is republished", async () => {
  const step = defineWorkflowStep("step")
    .input({})
    .output({})
    .run(() => ({}))
  const workflow = defineWorkflow("manual").input({}).then(step)
  const host = new SixbHost({
    id: "workflow-recovery",
    ontology: [],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    workflows: [workflow],
  })

  await createTestSixb(host).workflows.requestById({ workflowId: workflow.id, runId, input: {} })

  const pass = await republishLostRuns({
    projectId: host.id,
    storage: host.storage,
    queues: host.queues,
    events: host.events,
    now: new Date(Date.now() + 60_000),
  })
  expect(pass).toEqual({ republished: 1, settled: 0 })

  const jobs = await host.queues.workflows.claim({
    projectId: host.id,
    workerId: "observer",
    limit: 10,
  })
  expect(jobs.map((claimed) => claimed.job.id)).toEqual([runId])
})

// Drop the `givenUp` check from `executeRun` to watch this run resume for good.
test("a run given up on ends failed, with the node it left running", async () => {
  const gate = new RecoveryGate()
  const step = defineWorkflowStep("step")
    .input({})
    .output({})
    .run(() => gate.wait().then(() => ({})))
  const workflow = defineWorkflow("spent").input({}).then(step)
  const host = new SixbHost({
    id: "workflow-recovery",
    ontology: [],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    workflows: [workflow],
    onError() {},
  })
  const workflowRuns = host.storage.workflowRuns!
  const readRun = () => workflowRuns.getById({ projectId: host.id, id: runId })

  await createTestSixb(host).workflows.requestById({ workflowId: workflow.id, runId, input: {} })

  const dead = new WorkflowWorker(host)
  await dead.start()
  await gate.reached

  setSystemTime(new Date(Date.now() + LEASE_MS + 1))
  for (let crash = 1; crash <= 4; crash += 1) {
    await workflowRuns.startOrReclaim({
      projectId: host.id,
      id: runId,
      execution: { token: `crash-${crash}`, queueLeaseExpiresAt: new Date(0) },
    })
  }

  const worker = new WorkflowWorker(host)
  await worker.start()
  await waitFor(async () => (await readRun())?.status !== "running")
  await worker.stop()
  setSystemTime()

  expect(await readRun()).toMatchObject({
    status: "failed",
    error: { message: expect.stringContaining("stopped 5 times") },
  })

  const { nodes } = await workflowRuns.nodes.list({ projectId: host.id, workflowRunId: runId })
  expect(nodes.filter((node) => node.status === "running")).toEqual([])

  const [finished] = await host.events.read({ types: ["workflow.run.finished"] })
  expect(finished?.payload).toMatchObject({ runId, status: "failed" })

  gate.open()
  await dead.stop()
})
