import type { SixbClient } from "./api"
import { client as generatedClient } from "./generated/client.gen"
import { createSharedAccessClient, type SharedAccessClient } from "./shared"

export type SixbClientWithSharedAccess = SixbClient & {
  /** Creates an isolated shared-access client bound to one grant. */
  shared(grantId: string): SharedAccessClient
}

export const client: SixbClientWithSharedAccess = Object.assign(generatedClient, {
  shared(grantId: string): SharedAccessClient {
    const { baseUrl, fetch } = generatedClient.getConfig()
    return createSharedAccessClient({ grantId, baseUrl, fetch })
  },
})
