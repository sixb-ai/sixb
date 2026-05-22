import { NatsBrokerError } from "./errors"

// Records without a name still need a concrete final subject token so they
// live inside the stream subject filter and can be published consistently.
const DEFAULT_RECORD_NAME = "_"

/**
 * Build the broad subject filter owned by a single broker stream. Every record
 * written to that broker stream must publish under this prefix.
 */
export function buildStreamSubject(namespace: string, projectId: string, streamId: string): string {
  return `${namespace}.${projectId}.${encodeSubjectToken(streamId)}.>`
}

/**
 * Build the subject for one broker record. The record name is encoded into
 * the final subject token so name filters can run inside JetStream instead of
 * filtering every record in application code.
 */
export function buildRecordSubject(params: {
  readonly namespace: string
  readonly projectId: string
  readonly streamId: string
  readonly name?: string
}): string {
  return [
    params.namespace,
    params.projectId,
    encodeSubjectToken(params.streamId),
    encodeSubjectToken(params.name ?? DEFAULT_RECORD_NAME),
  ].join(".")
}

/**
 * Translate broker record-name filters into JetStream subject filters.
 */
export function buildNameFilters(params: {
  readonly namespace: string
  readonly projectId: string
  readonly streamId: string
  readonly names?: readonly string[]
}): readonly string[] | undefined {
  if (!params.names || params.names.length === 0) {
    return undefined
  }

  return params.names.map((name) =>
    buildRecordSubject({
      namespace: params.namespace,
      projectId: params.projectId,
      streamId: params.streamId,
      name,
    })
  )
}

export function assertNamespace(namespace: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(namespace)) {
    throw new NatsBrokerError(
      "namespace must contain only letters, numbers, underscores, and hyphens"
    )
  }
}

// NATS subjects are dot-separated, and stream names have their own restricted
// character set. Base64url lets arbitrary stream ids and record names remain
// lossless without leaking separators into the subject hierarchy.
export function encodeSubjectToken(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}
