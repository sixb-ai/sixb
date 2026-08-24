import type {
  SharedAccessClient,
  SharedAccessContext,
  SharedAccessResource,
} from "@sixb/client/shared"

export interface SharedAppBrowserLocation {
  readonly hash: string
  readonly pathname: string
  readonly search: string
}

export interface SharedAppBrowserHistory {
  readonly state: unknown
  replaceState(data: unknown, unused: string, url?: string | URL | null): void
}

export interface BootstrapSharedAppAccessOptions {
  readonly expectedShareTypeId: string
  readonly grantId: string
  readonly fragmentSecret: string | null
  readonly client: SharedAccessClient
}

export interface BootstrappedSharedAppAccess {
  readonly access: SharedAccessContext
  readonly resource: SharedAccessResource
}

/** Generic by design: the public page must not reveal which boundary check failed. */
export class SharedAppUnavailableError extends Error {
  constructor() {
    super("[SixbSharedApp] Shared access is unavailable.")
    this.name = "SharedAppUnavailableError"
  }
}

/**
 * Establishes one shared page without consulting the normal application session.
 * The fragment is removed before the long-lived link secret reaches the network.
 */
export async function bootstrapSharedAppAccess(
  options: BootstrapSharedAppAccessOptions
): Promise<BootstrappedSharedAppAccess> {
  const access = options.fragmentSecret
    ? await options.client.exchange(options.fragmentSecret)
    : await options.client.getSession()

  if (
    !access.authenticated ||
    access.grant.id !== options.grantId ||
    access.grant.shareTypeId !== options.expectedShareTypeId
  ) {
    throw new SharedAppUnavailableError()
  }

  const resource = await options.client.getResource()
  if (
    resource.objectTypeId !== access.grant.target.objectTypeId ||
    resource.primaryId !== access.grant.target.primaryId
  ) {
    throw new SharedAppUnavailableError()
  }

  return { access, resource }
}

export function consumeSharedAppFragmentSecret(
  location: SharedAppBrowserLocation,
  history: SharedAppBrowserHistory
): string | null {
  if (!location.hash) return null

  const secret = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash
  // Clear the credential before exchange. If history replacement fails, abort rather
  // than sending a reusable secret while it remains visible in the address bar.
  history.replaceState(history.state, "", `${location.pathname}${location.search}`)
  return secret || null
}
