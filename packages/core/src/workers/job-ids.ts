/**
 * Every id a job goes by, in one place. A queue provider keeps the id of a settled job and ignores a
 * new job under it, so what brings a run back can never reuse the run's own id: each of these names
 * the one thing it asks for, so that however many ask, it makes one job. A run's first job goes
 * under the run's id.
 */

/** A trigger joining a run that has not started. However many join, the run gets one job. */
export function joinJobId(runId: string): string {
  return `${runId}:join`
}

/** A finished run waking the one that waited for it. */
export function wakeJobId(runId: string, finishedRunId: string): string {
  return `${runId}:wake:${finishedRunId}`
}

/** The `runs` pass bringing back a running run. Stable per attempt: once is enough. */
export function recoverJobId(runId: string, attempt: number): string {
  return `${runId}:recover:${attempt}`
}

/** One flush request of a dataset, however many deliveries it covers. */
export function ingestFlushJobId(datasetId: string, request: number): string {
  return `ingest-flush:${datasetId}:${request}`
}

/** One interval's retention, so a restart or a second orchestrator requests nothing more. */
export function lakeRetentionJobId(intervalStart: string): string {
  return `lake-retention:${intervalStart}`
}
