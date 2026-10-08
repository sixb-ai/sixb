import type { RestRetryPolicy } from "@sixb/connector-rest"
import type { GoogleAuthOptions, GoogleOAuthOptions } from "../auth"

export interface GoogleConnectorOptions {
  readonly auth: GoogleAuthOptions
  readonly timeoutMs?: number
  readonly minDelayMs?: number
  readonly retry?: RestRetryPolicy
}

/** A Google connector whose accounts are connected through Sixb-managed OAuth. */
export interface GoogleOAuthConnectorOptions extends Omit<GoogleConnectorOptions, "auth"> {
  readonly auth: { readonly oauth: GoogleOAuthOptions }
}

export type * from "./analytics-admin"
export type * from "./analytics-data"
export type * from "./calendar"
export type * from "./drive"
export type * from "./gmail"
export type * from "./meet"
export type * from "./sheets"
