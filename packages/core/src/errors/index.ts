export {
  type ConnectorResponseErrorCode,
  connectorCodeForStatus,
  isSixbErrorCode,
  SIXB_ERROR_CODES,
  SIXB_ERROR_RETRYABLE,
  type SixbErrorCode,
  type SixbErrorNamespace,
  sixbErrorNamespace,
} from "./codes"
export type { SixbErrorKind } from "./error"
export {
  isSixbError,
  SIXB_AUTHORIZATION_ERROR_CODES,
  SIXB_CONFLICT_ERROR_CODES,
  SIXB_PROVIDER_ERROR_CODES,
  SIXB_TIMEOUT_ERROR_CODES,
  SIXB_VALIDATION_ERROR_CODES,
  SixbError,
  type SixbErrorLike,
  type SixbErrorOptions,
  sixbErrorKind,
  sixbFailureReason,
} from "./error"
export {
  parseSixbFailure,
  type SixbFailure,
  type SixbFailureDetails,
  serializeSixbFailure,
  type ToSixbFailureOptions,
  toSixbFailure,
} from "./failure"
