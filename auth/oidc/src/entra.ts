import type {
  OidcDirectory,
  OidcDirectoryApp,
  OidcDirectoryIdentity,
  OidcDirectoryVerdict,
} from "./directory"
import { OidcAuthError } from "./errors"

export type { OidcDirectory } from "./directory"

const GRAPH_URL = "https://graph.microsoft.com"
// The default access role Entra assigns when an app defines no roles. It has no value.
const DEFAULT_ACCESS_ROLE_ID = "00000000-0000-0000-0000-000000000000"
const BATCH_SIZE = 20
const PAGE_SIZE = 999

export interface EntraDirectoryOptions {
  /** How often to check, at least one minute. Defaults to one hour. */
  readonly intervalMs?: number
  /** Microsoft Graph's origin, for a national cloud. Defaults to `https://graph.microsoft.com`. */
  readonly graphUrl?: string
  /** Test hook: how requests reach Microsoft. */
  readonly fetch?: typeof fetch
}

/**
 * Microsoft Entra's directory, read through Microsoft Graph with the sign-in app's own client
 * credentials. Someone is `inactive` when they were deleted, disabled, or unassigned from the app
 * while it requires assignment; anyone else is `active`, with the app roles they hold now as their
 * `roles` claim.
 *
 * The app registration needs these Microsoft Graph application permissions, with admin consent:
 * `Application.Read.All` and `User.Read.All`, plus `GroupMember.Read.All` when app roles are
 * assigned to groups. The check needs no premium license; assigning an app to groups at all needs
 * Microsoft Entra ID P1.
 */
export function entraDirectory(options: EntraDirectoryOptions = {}): OidcDirectory {
  const graphUrl = new URL(options.graphUrl ?? GRAPH_URL).origin
  const fetcher = options.fetch ?? fetch

  return {
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    async check({ app, identities, signal }) {
      const tenant = entraTenant(app.issuer)
      const graph = new EntraGraph({
        graphUrl,
        token: await clientCredentialsToken(fetcher, app, tenant, graphUrl, signal),
        fetch: fetcher,
        signal,
      })

      const servicePrincipal = await graph.get<ServicePrincipal>(
        `/v1.0/servicePrincipals(appId='${encodeURIComponent(app.clientId)}')` +
          "?$select=id,appRoleAssignmentRequired,appRoles"
      )
      const rolesByUser = await assignedRoles(graph, servicePrincipal)

      const people = identities.flatMap((identity) => {
        const objectId = signedInObjectId(identity, tenant)
        return objectId ? [{ subject: identity.subject, objectId }] : []
      })
      const accounts = await graph.users(people.map(({ objectId }) => objectId))

      const verdicts = new Map<string, OidcDirectoryVerdict>()
      for (const { subject, objectId } of people) {
        const account = accounts.get(objectId)
        if (account === undefined) continue

        const roles = rolesByUser.get(objectId)
        const unassigned = servicePrincipal.appRoleAssignmentRequired === true && !roles
        if (account === "deleted" || !account.accountEnabled || unassigned) {
          verdicts.set(subject, { status: "inactive" })
        } else {
          verdicts.set(subject, { status: "active", claims: { roles: [...(roles ?? [])].sort() } })
        }
      }
      return verdicts
    },
  }
}

interface ServicePrincipal {
  readonly id: string
  readonly appRoleAssignmentRequired?: boolean
  readonly appRoles?: readonly { readonly id: string; readonly value?: string | null }[]
}

interface AppRoleAssignment {
  readonly principalId: string
  readonly principalType: string
  readonly appRoleId: string
}

type EntraAccount = { readonly accountEnabled: boolean } | "deleted"

/**
 * The role values each user holds, directly or through a group. A key means assigned. Entra assigns
 * an app to a group's direct members only, as sign-in does, so nested groups' members are not.
 */
async function assignedRoles(
  graph: EntraGraph,
  servicePrincipal: ServicePrincipal
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const values = new Map(
    (servicePrincipal.appRoles ?? []).flatMap((role) => (role.value ? [[role.id, role.value]] : []))
  )
  const assignments = await graph.list<AppRoleAssignment>(
    `/v1.0/servicePrincipals/${servicePrincipal.id}/appRoleAssignedTo` +
      `?$select=principalId,principalType,appRoleId&$top=${PAGE_SIZE}`
  )

  const rolesByUser = new Map<string, Set<string>>()
  const assign = (userId: string, roleId: string) => {
    const roles = rolesByUser.get(userId) ?? new Set<string>()
    const value = roleId === DEFAULT_ACCESS_ROLE_ID ? undefined : values.get(roleId)
    if (value) roles.add(value)
    rolesByUser.set(userId, roles)
  }
  const groupMembers = new Map<string, readonly { readonly id: string }[]>()
  for (const assignment of assignments) {
    if (assignment.principalType === "User") {
      assign(assignment.principalId, assignment.appRoleId)
    } else if (assignment.principalType === "Group") {
      let members = groupMembers.get(assignment.principalId)
      if (!members) {
        members = await graph.list<{ readonly id: string }>(
          `/v1.0/groups/${assignment.principalId}/members/microsoft.graph.user` +
            `?$select=id&$top=${PAGE_SIZE}`
        )
        groupMembers.set(assignment.principalId, members)
      }
      for (const member of members) assign(member.id, assignment.appRoleId)
    }
  }
  return rolesByUser
}

/** The tenant the issuer names: `https://login.microsoftonline.com/{tenant}/v2.0`. */
function entraTenant(issuer: URL): string {
  const [tenant, version, ...rest] = issuer.pathname.split("/").filter(Boolean)
  if (!tenant || version !== "v2.0" || rest.length > 0 || SHARED_TENANTS.has(tenant)) {
    throw new OidcAuthError(
      `entraDirectory needs your tenant's issuer, https://login.microsoftonline.com/<tenant-id>/v2.0, not '${issuer.href}'.`
    )
  }
  return tenant
}

const SHARED_TENANTS = new Set(["common", "organizations", "consumers"])
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Entra's `sub` differs per app, so a person is looked up by the `oid` their last sign-in sent,
// and only when it came from this tenant.
function signedInObjectId(identity: OidcDirectoryIdentity, tenant: string): string | undefined {
  const { oid, tid } = identity.claims
  if (typeof oid !== "string" || !GUID.test(oid)) return undefined
  if (GUID.test(tenant) && tid !== undefined && tid !== tenant.toLowerCase()) return undefined
  return oid.toLowerCase()
}

async function clientCredentialsToken(
  fetcher: typeof fetch,
  app: OidcDirectoryApp,
  tenant: string,
  graphUrl: string,
  signal: AbortSignal
): Promise<string> {
  const response = await fetcher(
    new URL(`/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, app.issuer.origin),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: app.clientId,
        client_secret: app.clientSecret,
        scope: `${graphUrl}/.default`,
      }),
      signal,
    }
  )
  const body = (await response.json().catch(() => ({}))) as {
    readonly access_token?: unknown
    readonly error?: unknown
    readonly error_codes?: unknown
  }
  if (response.ok && typeof body.access_token === "string") return body.access_token

  // Entra's description can echo request details; its code and AADSTS number say enough.
  const code = typeof body.error === "string" ? body.error : `HTTP ${response.status}`
  const aadsts = Array.isArray(body.error_codes) ? ` (AADSTS${body.error_codes[0]})` : ""
  throw new OidcAuthError(`entraDirectory could not get a Microsoft Graph token: ${code}${aadsts}.`)
}

class EntraGraph {
  constructor(
    private readonly options: {
      readonly graphUrl: string
      readonly token: string
      readonly fetch: typeof fetch
      readonly signal: AbortSignal
    }
  ) {}

  async get<T>(path: string): Promise<T> {
    return this.request<T>(new URL(path, this.options.graphUrl), { method: "GET" }, path)
  }

  /** Every page of a collection. */
  async list<T>(path: string): Promise<readonly T[]> {
    const items: T[] = []
    let url: URL | undefined = new URL(path, this.options.graphUrl)
    while (url) {
      const page: { readonly value: readonly T[]; readonly "@odata.nextLink"?: string } =
        await this.request(url, { method: "GET" }, path)
      items.push(...page.value)
      url = this.nextPage(page["@odata.nextLink"], path)
    }
    return items
  }

  /**
   * Each user's account state, 20 per batch request. A user Graph reports missing was deleted. Any
   * other answer fails the check: Graph refuses each user separately when `User.Read.All` is
   * missing, and a check that skipped them all would look like one that found no one gone.
   */
  async users(objectIds: readonly string[]): Promise<ReadonlyMap<string, EntraAccount>> {
    const accounts = new Map<string, EntraAccount>()
    const unique = [...new Set(objectIds)]
    for (let start = 0; start < unique.length; start += BATCH_SIZE) {
      const ids = unique.slice(start, start + BATCH_SIZE)
      const batch = await this.request<{
        readonly responses: readonly {
          readonly id: string
          readonly status: number
          readonly body?: {
            readonly accountEnabled?: unknown
            readonly error?: { readonly code?: unknown }
          }
        }[]
      }>(
        new URL("/v1.0/$batch", this.options.graphUrl),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requests: ids.map((id, index) => ({
              id: String(index),
              method: "GET",
              url: `/users/${id}?$select=id,accountEnabled`,
            })),
          }),
        },
        "/v1.0/$batch"
      )
      for (const response of batch.responses) {
        const id = ids[Number(response.id)]
        if (id === undefined) continue
        if (response.status === 404) {
          accounts.set(id, "deleted")
        } else if (response.status === 200 && typeof response.body?.accountEnabled === "boolean") {
          accounts.set(id, { accountEnabled: response.body.accountEnabled })
        } else {
          throw graphError(response.status, response.body?.error?.code, "/v1.0/users/{id}")
        }
      }
    }
    return accounts
  }

  private async request<T>(url: URL, init: RequestInit, label: string): Promise<T> {
    const response = await this.options.fetch(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${this.options.token}` },
      signal: this.options.signal,
    })
    if (response.ok) return (await response.json()) as T

    const body = (await response.json().catch(() => ({}))) as {
      readonly error?: { readonly code?: unknown }
    }
    throw graphError(response.status, body.error?.code, label)
  }

  // A next page Graph names elsewhere would receive the token, so only Graph's own is followed.
  private nextPage(link: string | undefined, path: string): URL | undefined {
    if (!link) return undefined
    const url = new URL(link)
    if (url.origin !== this.options.graphUrl) {
      throw new OidcAuthError(
        `Microsoft Graph sent a next page outside ${this.options.graphUrl} for ${path}.`
      )
    }
    return url
  }
}

function graphError(status: number, code: unknown, label: string): OidcAuthError {
  const named = typeof code === "string" ? `: ${code}` : ""
  const hint =
    status === 401 || status === 403
      ? " Grant the app registration the Microsoft Graph application permissions " +
        "Application.Read.All and User.Read.All (and GroupMember.Read.All when roles are " +
        "assigned to groups), with admin consent."
      : ""
  return new OidcAuthError(
    `Microsoft Graph answered ${status}${named} to ${label.split("?")[0]}.${hint}`
  )
}
