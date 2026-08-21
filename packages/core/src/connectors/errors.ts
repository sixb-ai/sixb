import {
  createSixbError,
  isSixbError,
  type SixbCodedError,
  type SixbErrorOptions,
} from "../errors/internal"
import type { SixbErrorCode } from "../errors/types"
import { ConnectorConnectionStorageError } from "../storage/connector-connections/errors"

type ConnectorCodedErrorCode = Extract<SixbErrorCode, `connector.${string}`> | "internal.unexpected"

/**
 * Legacy authoring error for static connector definitions and lookup.
 *
 * Persistent connection lifecycle failures use the global `SixbErrorCode` contract instead.
 * `ConnectorOAuthError` remains a class because adapters and Core need `instanceof` control flow at
 * the provider-effect boundary.
 */
export class ConnectorError extends Error {
  readonly name: string = "ConnectorError"
}

export class ConnectorNotFoundError extends ConnectorError {
  override readonly name = "ConnectorNotFoundError"
  constructor(readonly connectorId: string) {
    super(`Unknown connector '${connectorId}'`)
  }
}

/**
 * Provider mutation outcome reported by an OAuth adapter.
 *
 * `retryable` guarantees that the provider made no change. `terminal` means the current grant can
 * no longer progress. `ambiguous` means the provider may have changed state; Core fails closed.
 * This classifies the provider effect, not the final Sixb error retry policy: Core also accounts for
 * one-use state, consumed authorization codes, and durable mutation phase before choosing a code.
 */
export type ConnectorOAuthErrorKind = "retryable" | "terminal" | "ambiguous"

/** Adapter signal used by Core to decide whether a provider operation can be retried safely. */
export class ConnectorOAuthError extends ConnectorError {
  override readonly name = "ConnectorOAuthError"

  constructor(
    readonly kind: ConnectorOAuthErrorKind,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

/** Internal factory for connector failures that cross a Sixb boundary. */
export function createConnectorCodedError(
  code: ConnectorCodedErrorCode,
  message: string,
  options: SixbErrorOptions = {}
): SixbCodedError {
  return createSixbError(
    code,
    message.startsWith("[Sixb]") ? message : `[Sixb] ${message}`,
    options
  )
}

/** Internal failure used when a provider operation may have completed after Core lost its fence. */
export function createAmbiguousProviderOperationError(
  options: SixbErrorOptions = {}
): SixbCodedError {
  return createConnectorCodedError(
    "connector.provider_failed",
    "Connector provider operation outcome is ambiguous.",
    options
  )
}

export function oauthErrorKind(error: unknown): ConnectorOAuthErrorKind {
  return error instanceof ConnectorOAuthError ? error.kind : "ambiguous"
}

export function providerFailureCode(
  error: unknown
): "connector.provider_failed" | "connector.provider_unavailable" {
  return oauthErrorKind(error) === "retryable"
    ? "connector.provider_unavailable"
    : "connector.provider_failed"
}

export function providerBoundaryError(
  error: unknown,
  code: "connector.provider_failed" | "connector.provider_unavailable",
  message: string
): Error {
  if (isSixbError(error)) return error
  return createConnectorCodedError(code, message, { cause: error })
}

export function isConnectorStorageError(
  error: unknown,
  code?: ConnectorConnectionStorageError["code"]
): error is ConnectorConnectionStorageError {
  return (
    error instanceof ConnectorConnectionStorageError && (code === undefined || error.code === code)
  )
}

export function storageBoundaryError(error: unknown, message: string): SixbCodedError {
  return createConnectorCodedError("internal.unexpected", message, { cause: error })
}

export async function recoverConnectorFailure<T>(
  primaryError: unknown,
  message: string,
  recovery: () => Promise<T>
): Promise<T> {
  try {
    return await recovery()
  } catch (recoveryError) {
    throw createConnectorCodedError("internal.unexpected", message, {
      cause: new AggregateError([primaryError, recoveryError], message),
    })
  }
}
