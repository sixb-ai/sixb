import { natsBrokerError } from "./errors"

// Records without a name still need a concrete final subject token so they
// live inside the stream subject filter and can be published consistently.
const DEFAULT_RECORD_NAME = "_"
const DEFAULT_RECORD_KEY = "_"

/**
 * Build the broad subject filter owned by a single broker stream. Every record
 * written to that broker stream must publish under this prefix.
 */
export function buildStreamSubject(namespace: string, projectId: string, streamId: string): string {
  return `${namespace}.${projectId}.${encodeSubjectToken(streamId)}.>`
}

/**
 * Build the subject for one broker record. Name and key are encoded into the
 * final two subject tokens so both filters can run inside JetStream.
 */
export function buildRecordSubject(params: {
  readonly namespace: string
  readonly projectId: string
  readonly streamId: string
  readonly name?: string
  readonly key?: string
}): string {
  return [
    params.namespace,
    params.projectId,
    encodeSubjectToken(params.streamId),
    encodeSubjectToken(params.name ?? DEFAULT_RECORD_NAME),
    encodeSubjectToken(params.key ?? DEFAULT_RECORD_KEY),
  ].join(".")
}

/**
 * Translate broker record-name filters into JetStream subject filters.
 */
export function buildRecordFilters(params: {
  readonly namespace: string
  readonly projectId: string
  readonly streamId: string
  readonly names?: readonly string[]
  readonly keys?: readonly string[]
}): readonly string[] | undefined {
  const names = params.names && params.names.length > 0 ? params.names : [undefined]
  const keys = params.keys && params.keys.length > 0 ? params.keys : [undefined]
  if (names[0] === undefined && keys[0] === undefined) {
    return undefined
  }

  return names.flatMap((name) =>
    keys.map((key) =>
      [
        params.namespace,
        params.projectId,
        encodeSubjectToken(params.streamId),
        name === undefined ? "*" : encodeSubjectToken(name),
        key === undefined ? "*" : encodeSubjectToken(key),
      ].join(".")
    )
  )
}

export function assertNamespace(namespace: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(namespace)) {
    throw natsBrokerError("namespace must contain only letters, numbers, underscores, and hyphens")
  }
}

// NATS subjects are dot-separated, and stream names have their own restricted
// character set. Base64url lets arbitrary stream ids and record names remain
// lossless without leaking separators into the subject hierarchy.
export function encodeSubjectToken(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}
