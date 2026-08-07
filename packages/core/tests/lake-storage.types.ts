import {
  change,
  col,
  defineDataset,
  definePipelineStep,
  defineSync,
  type MergeChange,
} from "../src"
import type {
  BeginDatasetMergeInput,
  CommitDatasetMergeInput,
  DatasetMergeCommitResult,
  DatasetRow,
  DatasetVersion,
  DatasetVersionMode,
  DatasetWriteMode,
  LakeMergeSession,
  LakeStorage,
} from "../src/lake-storage"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

type MergeCapableLakeStorage = LakeStorage & Required<Pick<LakeStorage, "beginMerge">>
type _baseMergeIsOptional = Expect<undefined extends LakeStorage["beginMerge"] ? true : false>
type _writeModesRemainNarrow = Expect<Equal<DatasetWriteMode, "snapshot" | "append">>
type _versionModesIncludeMerge = Expect<
  Equal<DatasetVersionMode, "snapshot" | "append" | "merge" | "schema">
>

const dataset = defineDataset("contract.merge.invoices", {
  schema: [col("id", "string"), col("status", "string")],
  primaryKey: "id",
})

const beginInput: BeginDatasetMergeInput = {
  dataset,
  producer: { kind: "sync", id: "sync-invoices", runId: "run_1" },
  inputs: [{ datasetId: "source.invoices", versionId: "ver_1" }],
}
const commitInput: CommitDatasetMergeInput = { commitMessage: "merge invoices" }
// @ts-expect-error beginMerge selects the operation without accepting an ordinary write mode
const _mergeInputWithMode: BeginDatasetMergeInput = { dataset, mode: "merge" }

declare const mergeStorage: MergeCapableLakeStorage
declare const mergeSession: LakeMergeSession
declare const version: DatasetVersion

const _session: Promise<LakeMergeSession> = mergeStorage.beginMerge(beginInput)
const _changes: MergeChange<DatasetRow, DatasetRow>[] = [
  change.upsert({ id: "inv_1", status: "open" }),
  change.delete({ id: "inv_2" }),
]
const _writeChanges: Promise<void> = mergeSession.writeChanges(_changes)
const _commit: Promise<DatasetMergeCommitResult> = mergeSession.commit(commitInput)

async function* asyncChanges(): AsyncIterable<MergeChange<DatasetRow, DatasetRow>> {
  yield change.delete({ id: "inv_3" })
}

mergeSession.writeChanges(asyncChanges())

const _created: DatasetMergeCommitResult = { outcome: "created", version }
const _initialNoOp: DatasetMergeCommitResult = { outcome: "unchanged", version: null }
const _laterNoOp: DatasetMergeCommitResult = { outcome: "unchanged", version }

function narrowMergeResult(result: DatasetMergeCommitResult): DatasetVersion | null {
  if (result.outcome === "created") {
    const _version: DatasetVersion = result.version
    return _version
  }

  const _version: DatasetVersion | null = result.version
  return _version
}

declare const baseStorage: LakeStorage
const _optionalMerge = baseStorage.beginMerge?.(beginInput)
// @ts-expect-error beginMerge remains optional until DuckLake implements it in the next PR
baseStorage.beginMerge(beginInput)
// @ts-expect-error merge commits guard the version captured at beginMerge automatically
mergeSession.commit({ expectedLatestVersionId: "ver_1" })
// @ts-expect-error merge is not an ordinary dataset write mode
const _mergeWriteMode: DatasetWriteMode = "merge"
// @ts-expect-error user-facing merge syncs are deferred to a later PR
defineSync("sync-invoices-merge", { mode: "merge" })
definePipelineStep("merge-invoices").inputs({ invoices: dataset }).output(dataset, {
  // @ts-expect-error merge pipeline outputs are outside the V1 scope
  mode: "merge",
})

void _session
void _writeChanges
void _commit
void _created
void _initialNoOp
void _laterNoOp
void _mergeInputWithMode
void _optionalMerge
void narrowMergeResult
