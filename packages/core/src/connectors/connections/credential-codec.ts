import type { ConnectorCredentialProtector, SealedConnectorCredential } from "../credentials"
import type { ConnectorOAuthCredentials } from "../types"
import { parseCredentials, serializeCredentials } from "./validation"

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export interface ConnectorCredentialCodecOptions {
  readonly projectId: string
  readonly protector: ConnectorCredentialProtector
}

/** Authenticated serialization boundary for one project's OAuth credential envelopes. */
export class ConnectorCredentialCodec {
  constructor(private readonly options: ConnectorCredentialCodecOptions) {}

  seal(
    connectorId: string,
    authorizationId: string,
    credentials: ConnectorOAuthCredentials
  ): Promise<SealedConnectorCredential> {
    return this.options.protector.seal(
      textEncoder.encode(serializeCredentials(credentials)),
      this.context(connectorId, authorizationId)
    )
  }

  async open(
    connectorId: string,
    authorizationId: string,
    credentials: SealedConnectorCredential
  ): Promise<ConnectorOAuthCredentials> {
    const plaintext = await this.options.protector.open(
      credentials,
      this.context(connectorId, authorizationId)
    )
    return parseCredentials(textDecoder.decode(plaintext))
  }

  private context(connectorId: string, authorizationId: string) {
    return {
      projectId: this.options.projectId,
      connectorId,
      recordId: authorizationId,
      purpose: "oauth-authorization" as const,
    }
  }
}
