import type {
  GetPipelineRunResponses,
  ListPipelineRunsResponses,
  ListPipelinesResponses,
} from "../src/generated/types.gen"

type LatestPipelineRun = NonNullable<ListPipelinesResponses[200][number]["latestRun"]>
type ListedPipelineRun = ListPipelineRunsResponses[200]["runs"][number]
type PipelineStepRun = GetPipelineRunResponses[200]["steps"][number]

type LatestFailureCode = NonNullable<LatestPipelineRun["error"]>["code"]
type ListedFailureCode = NonNullable<ListedPipelineRun["error"]>["code"]
type StepFailureCode = NonNullable<PipelineStepRun["error"]>["code"]

const latestUnexpected: LatestFailureCode = "internal.unexpected"
const latestCancelled: LatestFailureCode = "runtime.cancelled"
const listedUnexpected: ListedFailureCode = "internal.unexpected"
const stepCancelled: StepFailureCode = "runtime.cancelled"
const latestStepFailed: LatestFailureCode = "pipeline.step_failed"
const stepFailed: StepFailureCode = "pipeline.step_failed"

// Dataset lookup codes belong to HTTP route failures, not persisted pipeline failures.
// @ts-expect-error the generated latest-run failure contract must stay scoped to its producer
const unrelatedLatest: LatestFailureCode = "dataset.not_found"
// @ts-expect-error the generated run-history failure contract must stay scoped to its producer
const unrelatedListed: ListedFailureCode = "dataset.not_found"
// @ts-expect-error the generated step-run failure contract must stay scoped to its producer
const unrelatedStep: StepFailureCode = "dataset.not_found"

void [
  latestUnexpected,
  latestCancelled,
  listedUnexpected,
  stepCancelled,
  latestStepFailed,
  stepFailed,
  unrelatedLatest,
  unrelatedListed,
  unrelatedStep,
]
