import type { RestRetryPolicy } from "@sixb/connector-rest"
import type { GoogleAuthOptions } from "../auth"

export interface GoogleConnectorOptions {
  readonly auth: GoogleAuthOptions
  readonly timeoutMs?: number
  readonly minDelayMs?: number
  readonly retry?: RestRetryPolicy
}

export type * from "./analytics-admin"
export type * from "./analytics-data"
export type * from "./calendar"
export type * from "./drive"
export type * from "./gmail"
export type * from "./meet"
export type * from "./sheets"
