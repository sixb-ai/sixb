export interface MicrosoftTokenContext {
  readonly signal: AbortSignal
  /** True after a 401. A resolver with its own cache must bypass it. */
  readonly forceRefresh: boolean
}

export interface MicrosoftClientCertificate {
  /** Hex SHA-256 fingerprint of the certificate uploaded in Entra. */
  readonly thumbprintSha256: string
  /** PEM-encoded RSA private key matching that certificate. */
  readonly privateKey: string
}

export type MicrosoftAuthOptions =
  | {
      readonly tenantId: string
      readonly clientId: string
      readonly clientSecret: string
      readonly clientCertificate?: never
      readonly token?: never
    }
  | {
      readonly tenantId: string
      readonly clientId: string
      readonly clientCertificate: MicrosoftClientCertificate
      readonly clientSecret?: never
      readonly token?: never
    }
  | {
      /** Caller owns token acquisition and renewal (including managed/federated identity). */
      readonly token: (context: MicrosoftTokenContext) => string | Promise<string>
      readonly tenantId?: never
      readonly clientId?: never
      readonly clientSecret?: never
      readonly clientCertificate?: never
    }
