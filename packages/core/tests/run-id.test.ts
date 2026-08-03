import { describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
  col,
  defineAction,
  defineConnector,
  defineDataset,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineSync,
  defineWorkflow,
  defineWorkflowStep,
  type PipelineDefinition,
  prop,
  ref,
  Sixb,
  type WorkflowDefinition,
} from "../src"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Contract = defineObjectType({
  id: "contract",
  name: "Contract",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const ContractsDataset = defineDataset("raw.contracts", { schema: [col("id", "string")] })

const source = defineConnector("source", {
  type: "test",
  async connect() {
    return {}
  },
})

const syncContracts = defineSync("sync-contracts")
  .from(source)
  .read(() => [])
  .intoDataset(ContractsDataset)

const contractStep = definePipelineStep("contract-step")
  .inputs({ contracts: ContractsDataset })
  .output(ContractsDataset)
  .run(async () => {})

// Widened to the base type: registration and id lookup only, which keeps the registered arrays out
// of the deep `Sixb<tuple>` instantiation (TS2589).
const contractPipeline: PipelineDefinition = definePipeline("contract-pipeline").then(contractStep)

const reviewContract = defineWorkflowStep("review-contract")
  .input({ contract: ref(Contract) })
  .output({ approved: "boolean" })
  .run(async () => ({ approved: true }))

const contractWorkflow: WorkflowDefinition = defineWorkflow("contract-workflow")
  .input({ contract: ref(Contract) })
  .then(reviewContract)

const archiveContract: ActionDefinition = defineAction("archive-contract")
  .on(Contract)
  .params({})
  .edits(() => {})

function createSixb() {
  return new Sixb({
    id: "run-id-test",
    ontology: [Contract],
    datasets: [ContractsDataset],
    connectors: [source],
    syncs: [syncContracts],
    pipelines: [contractPipeline],
    workflows: [contractWorkflow],
    actions: [archiveContract],
    ...createTestRuntimeDeps(),
  })
}

/**
 * Four run-request APIs, one caller mistake, one code.
 *
 * They disagreed: the action said `ontology.invalid_value`, sync and pipeline said
 * `runtime.invalid_definition` — which answers **500**, blaming the app's own `define*()` call for
 * a blank string the caller passed — and only the workflow said `runtime.invalid_input`. Removing
 * the fix restores four codes and two of these expectations fail on the status alone.
 */
describe("an empty run id is the caller's mistake", () => {
  test("every run request rejects a blank run id with runtime.invalid_input", async () => {
    const sixb = createSixb()
    const contract = { objectTypeId: "contract" as const, primaryId: "contract:1" }

    await expect(
      sixb.objects(Contract).requestAction({
        id: "contract:1",
        actionId: "archive-contract",
        params: {},
        runId: "   ",
      })
    ).rejects.toHaveProperty("code", "runtime.invalid_input")

    await expect(
      sixb.requestSyncRun({ syncId: "sync-contracts", runId: "   " })
    ).rejects.toHaveProperty("code", "runtime.invalid_input")

    await expect(
      sixb.requestPipelineRun({ pipelineId: "contract-pipeline", runId: "   " })
    ).rejects.toHaveProperty("code", "runtime.invalid_input")

    await expect(
      sixb.requestWorkflowRun({
        workflowId: "contract-workflow",
        input: { contract },
        runId: "   ",
      })
    ).rejects.toHaveProperty("code", "runtime.invalid_input")
  })
})
