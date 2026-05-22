import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  col,
  defineAction,
  defineConnector,
  defineDataset,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineProjection,
  defineSync,
  defineWorkflow,
  defineWorkflowStep,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  Pario,
  prop,
} from "@pario/core"
import { resolveWorkerTypesToStart } from "../src/lib/worker-registry"

const WorkerRoom = defineObjectType({
  id: "WorkerRoom",
  name: "Worker room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const workerConnector = defineConnector("workerConnector", {
  type: "sql",
  connect() {
    return {}
  },
})

const workerDataset = defineDataset("worker.dataset", {
  schema: [col("id", "string", { nullable: false })],
})

const workerAction = defineAction("worker-action")
  .target(WorkerRoom)
  .params({})
  .run(() => {})

const workerPipelineStep = definePipelineStep("worker-pipeline-step")
  .inputs({ source: workerDataset })
  .output(workerDataset)
  .run(() => {})

const workerWorkflowStep = defineWorkflowStep("worker-workflow-step")
  .input({})
  .output({})
  .run(() => ({}))

function runWorkerFixture(
  fixtureName: string,
  args: readonly string[] = []
): {
  exitCode: number
  stdout: string
  stderr: string
} {
  const repoRoot = resolve(import.meta.dir, "..", "..", "..")
  const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")
  const fixtureEntry = resolve(import.meta.dir, "fixtures", fixtureName, "pario.config.ts")

  const result = Bun.spawnSync({
    cmd: ["bun", cliEntry, "worker", "--entry", fixtureEntry, ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf-8"),
    stderr: Buffer.from(result.stderr).toString("utf-8"),
  }
}

function createRegistryPario(options: {
  readonly sync?: boolean
  readonly action?: boolean
  readonly pipeline?: boolean
  readonly projection?: boolean
  readonly workflow?: boolean
}) {
  const sync = defineSync("worker-sync")
    .from(workerConnector)
    .read(() => [])
    .intoDataset(workerDataset)
  const pipeline = definePipeline("worker-pipeline").then(workerPipelineStep)
  const projection = defineProjection("worker-projection", WorkerRoom)
    .fromDataset(workerDataset)
    .properties({ id: "id" })
  const workflow = defineWorkflow("worker-workflow").input({}).then(workerWorkflowStep)
  const needsDataset = options.sync || options.pipeline || options.projection

  return new Pario({
    id: "worker-registry-tests",
    ontology: [WorkerRoom],
    connectors: options.sync ? [workerConnector] : [],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    datasets: needsDataset ? [workerDataset] : [],
    syncs: options.sync ? [sync] : [],
    actions: options.action ? [workerAction] : [],
    pipelines: options.pipeline ? [pipeline] : [],
    projections: options.projection ? [projection] : [],
    workflows: options.workflow ? [workflow] : [],
  })
}

function runHelp(): { exitCode: number; stdout: string; stderr: string } {
  const repoRoot = resolve(import.meta.dir, "..", "..", "..")
  const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")

  const result = Bun.spawnSync({
    cmd: ["bun", cliEntry, "help"],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf-8"),
    stderr: Buffer.from(result.stderr).toString("utf-8"),
  }
}

describe("pario worker", () => {
  test("fails fast when the project uses InMemoryQueues", () => {
    const result = runWorkerFixture("valid-project", ["--worker", "sync"])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("requires a queue provider")
    expect(result.stdout).toContain("InMemoryQueues")
    expect(result.stderr).toBe("")
  })

  test("rejects unknown worker types before checking queue provider", () => {
    const result = runWorkerFixture("valid-project", ["--worker", "missing"])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("Unknown worker 'missing'")
    expect(result.stdout).toContain("sync, action, pipeline")
    expect(result.stdout).toContain("projection, workflow")
    expect(result.stdout).not.toContain("requires a queue provider")
    expect(result.stderr).toBe("")
  })

  test("accepts workflow as a known explicit worker type", () => {
    const result = runWorkerFixture("valid-project", ["--worker", "workflow"])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("requires a queue provider")
    expect(result.stdout).toContain("InMemoryQueues")
    expect(result.stdout).not.toContain("Unknown worker")
    expect(result.stderr).toBe("")
  })

  test("is listed in the CLI help", () => {
    const result = runHelp()

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("worker")
    expect(result.stdout).toContain("--worker <type>")
    expect(result.stdout).toContain("sync, action, pipeline")
    expect(result.stdout).toContain("workflow")
    expect(result.stderr).toBe("")
  })

  test("resolves default worker types from registered definitions", () => {
    expect(() => resolveWorkerTypesToStart(createRegistryPario({}))).toThrow(
      "No worker definitions are registered"
    )
    expect(resolveWorkerTypesToStart(createRegistryPario({ sync: true }))).toEqual(["sync"])
    expect(resolveWorkerTypesToStart(createRegistryPario({ action: true }))).toEqual(["action"])
    expect(resolveWorkerTypesToStart(createRegistryPario({ pipeline: true }))).toEqual(["pipeline"])
    expect(resolveWorkerTypesToStart(createRegistryPario({ projection: true }))).toEqual([
      "projection",
    ])
    expect(resolveWorkerTypesToStart(createRegistryPario({ workflow: true }))).toEqual(["workflow"])
    expect(
      resolveWorkerTypesToStart(
        createRegistryPario({
          sync: true,
          action: true,
          pipeline: true,
          projection: true,
          workflow: true,
        })
      )
    ).toEqual(["sync", "action", "pipeline", "projection", "workflow"])
  })

  test("starts the requested worker type directly", () => {
    expect(resolveWorkerTypesToStart(createRegistryPario({}), "pipeline")).toEqual(["pipeline"])
    expect(resolveWorkerTypesToStart(createRegistryPario({}), "workflow")).toEqual(["workflow"])
  })

  test("rejects unknown workers with the known worker list", () => {
    expect(() => resolveWorkerTypesToStart(createRegistryPario({}), "missing")).toThrow(
      "Available: sync, action, pipeline, projection, workflow"
    )
  })
})
