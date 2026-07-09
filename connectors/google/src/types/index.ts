import type { RestRetryPolicy } from "@sixb/connector-rest"
import type { GoogleAuthOptions } from "../auth"

export interface GoogleConnectorOptions {
  readonly auth: GoogleAuthOptions
  readonly timeoutMs?: number
  readonly minDelayMs?: number
  readonly retry?: RestRetryPolicy
}

export type * from "./drive"
