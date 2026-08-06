import type { GetActionRunResponses, ListActionRunsResponses } from "../src/generated/types.gen"

type ListedActionRun = ListActionRunsResponses[200]["runs"][number]
type ActionRunDetail = GetActionRunResponses[200]
type ListedFailureCode = NonNullable<ListedActionRun["error"]>["code"]
type DetailFailureCode = NonNullable<ActionRunDetail["error"]>["code"]

const listedUnexpected: ListedFailureCode = "internal.unexpected"
const listedCancelled: ListedFailureCode = "runtime.cancelled"
const detailUnexpected: DetailFailureCode = "internal.unexpected"

// Dataset lookup codes belong to HTTP route failures, not persisted Action failures.
// @ts-expect-error the generated Action failure contract must stay scoped to its producer
const unrelated: DetailFailureCode = "dataset.not_found"

type FailedWriteback = Extract<NonNullable<ActionRunDetail["writeback"]>, { status: "failed" }>
type FailedEffects = Extract<NonNullable<ActionRunDetail["effects"]>, { status: "failed" }>

const writebackPhase: FailedWriteback["error"]["details"]["phase"] = "writeback"
const effectsPhase: FailedEffects["error"]["details"]["phase"] = "effects"

// @ts-expect-error a writeback record cannot carry an effects failure
const unrelatedWritebackPhase: FailedWriteback["error"]["details"]["phase"] = "effects"
// @ts-expect-error an effects record cannot carry a writeback failure
const unrelatedEffectsPhase: FailedEffects["error"]["details"]["phase"] = "writeback"

void [
  listedUnexpected,
  listedCancelled,
  detailUnexpected,
  unrelated,
  writebackPhase,
  effectsPhase,
  unrelatedWritebackPhase,
  unrelatedEffectsPhase,
]
