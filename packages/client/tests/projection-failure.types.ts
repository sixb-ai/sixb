import type {
  GetProjectionResponses,
  GetProjectionRunResponses,
  ListProjectionRunsResponses,
  ListProjectionsResponses,
} from "../src/generated/types.gen"

type LatestRun = NonNullable<
  ListProjectionsResponses[200]["objectProjections"][number]["latestRun"]
>
type ProjectionLatestRun = NonNullable<GetProjectionResponses[200]["latestRun"]>
type ListedRun = ListProjectionRunsResponses[200]["runs"][number]
type DetailedRun = GetProjectionRunResponses[200]

type LatestFailureCode = NonNullable<LatestRun["error"]>["code"]
type ProjectionFailureCode = NonNullable<ProjectionLatestRun["error"]>["code"]
type ListedFailureCode = NonNullable<ListedRun["error"]>["code"]
type DetailedFailureCode = NonNullable<DetailedRun["error"]>["code"]

const latestUnexpected: LatestFailureCode = "internal.unexpected"
const projectionCancelled: ProjectionFailureCode = "runtime.cancelled"
const listedUnexpected: ListedFailureCode = "internal.unexpected"
const detailedCancelled: DetailedFailureCode = "runtime.cancelled"

// Dataset lookup codes belong to HTTP route failures, not persisted projection-run failures.
// @ts-expect-error the generated projection failure contract must stay scoped to its producer
const unrelatedLatest: LatestFailureCode = "dataset.not_found"
// @ts-expect-error projection run detail must expose the same closed failure scope
const unrelatedDetailed: DetailedFailureCode = "dataset.not_found"

void [
  latestUnexpected,
  projectionCancelled,
  listedUnexpected,
  detailedCancelled,
  unrelatedLatest,
  unrelatedDetailed,
]
