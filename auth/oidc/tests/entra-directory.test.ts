import { describe, expect, test } from "bun:test"
import { defineGroup, type GroupDefinition } from "@sixb/core"
import type { UserIdentityRecord } from "@sixb/core/auth/strategy"
import { oidc } from "../src"
import type { OidcClaims } from "../src/claims"
import type { OidcDirectoryIdentity } from "../src/directory"
import { entraDirectory } from "../src/entra"

const TENANT = "11111111-1111-4111-8111-111111111111"
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222"
const ISSUER = new URL(`https://login.microsoftonline.com/${TENANT}/v2.0`)
const app = { issuer: ISSUER, clientId: "client-id", clientSecret: "client-secret" }
const DEFAULT_ACCESS = "00000000-0000-0000-0000-000000000000"

/** The object id Entra gives each person in these tests: their name, in hex. */
const oid = (name: string) =>
  `00000000-0000-4000-8000-${Buffer.from(name).toString("hex").padStart(12, "0")}`

function identity(name: string, claims: Record<string, unknown> = {}): OidcDirectoryIdentity {
  return {
    subject: `sub-${name}`,
    claims: { sub: `sub-${name}`, email_verified: false, oid: oid(name), tid: TENANT, ...claims },
  }
}

interface Tenant {
  readonly assignmentRequired?: boolean
  /** principal name → role id, for users; `group:<id>` for groups. */
  readonly assignments: readonly { readonly principal: string; readonly roleId: string }[]
  readonly groups?: Record<string, readonly string[]>
  /** name → enabled; `deleted` answers 404, `forbidden` 403. */
  readonly accounts: Record<string, boolean | "deleted" | "forbidden">
}

/** Microsoft's endpoints, answered from `tenant`. Records each request it saw. */
function fakeMicrosoft(
  tenant: Tenant,
  overrides: { readonly graph?: (url: URL) => Response | undefined } = {}
) {
  const requests: { readonly method: string; readonly url: URL; readonly body?: string }[] = []
  const byOid = new Map(Object.keys(tenant.accounts).map((name) => [oid(name), name]))
  const json = (body: unknown, status = 200) => Response.json(body, { status })

  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === "string" ? init.body : init?.body?.toString()
    requests.push({ method: init?.method ?? "GET", url, ...(body ? { body } : {}) })

    if (url.origin === "https://login.microsoftonline.com") {
      return json({ access_token: "graph-token", token_type: "Bearer", expires_in: 3599 })
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer graph-token")
    const overridden = overrides.graph?.(url)
    if (overridden) return overridden

    if (url.pathname === "/v1.0/servicePrincipals(appId='client-id')") {
      return json({
        id: "sp-1",
        appRoleAssignmentRequired: tenant.assignmentRequired ?? true,
        appRoles: [
          { id: "role-admin", value: "Sixb.Admin" },
          { id: "role-member", value: "Sixb.Member" },
        ],
      })
    }
    if (url.pathname === "/v1.0/servicePrincipals/sp-1/appRoleAssignedTo") {
      // Two pages, so paging is followed.
      const all = tenant.assignments.map(({ principal, roleId }) =>
        principal.startsWith("group:")
          ? { principalId: principal.slice(6), principalType: "Group", appRoleId: roleId }
          : { principalId: oid(principal), principalType: "User", appRoleId: roleId }
      )
      const second = url.searchParams.get("page") === "2"
      const half = Math.ceil(all.length / 2)
      return json({
        value: second ? all.slice(half) : all.slice(0, half),
        ...(second ? {} : { "@odata.nextLink": `${url.origin}${url.pathname}?page=2` }),
      })
    }
    const group = url.pathname.match(/^\/v1\.0\/groups\/([^/]+)\/members\/microsoft\.graph\.user$/)
    if (group?.[1]) {
      return json({ value: (tenant.groups?.[group[1]] ?? []).map((name) => ({ id: oid(name) })) })
    }
    if (url.pathname === "/v1.0/$batch") {
      const { requests: batch } = JSON.parse(body ?? "{}") as {
        requests: { id: string; url: string }[]
      }
      expect(batch.length).toBeLessThanOrEqual(20)
      return json({
        responses: batch.map(({ id, url: path }) => {
          const name = byOid.get(path.split("/")[2]?.split("?")[0] ?? "")
          const account = name === undefined ? "deleted" : tenant.accounts[name]
          if (account === "deleted")
            return { id, status: 404, body: { error: { code: "Request_ResourceNotFound" } } }
          if (account === "forbidden") {
            return { id, status: 403, body: { error: { code: "Authorization_RequestDenied" } } }
          }
          return { id, status: 200, body: { id: oid(name ?? ""), accountEnabled: account } }
        }),
      })
    }
    return json({ error: { code: "UnexpectedRequest" } }, 400)
  }) as typeof fetch

  return { fetch: fetcher, requests }
}

async function check(
  tenant: Tenant,
  identities: readonly OidcDirectoryIdentity[],
  overrides?: Parameters<typeof fakeMicrosoft>[1]
) {
  const microsoft = fakeMicrosoft(tenant, overrides)
  const verdicts = await entraDirectory({ fetch: microsoft.fetch }).check({
    app,
    identities,
    signal: AbortSignal.timeout(5_000),
  })
  return { verdicts: Object.fromEntries(verdicts), requests: microsoft.requests }
}

const team: Tenant = {
  assignments: [
    { principal: "ada", roleId: "role-admin" },
    { principal: "group:engineering", roleId: "role-member" },
    { principal: "eve", roleId: DEFAULT_ACCESS },
  ],
  groups: { engineering: ["ben", "cleo"] },
  accounts: {
    ada: true,
    ben: true,
    cleo: false,
    dan: true,
    eve: true,
    frank: "deleted",
  },
}

describe("entraDirectory", () => {
  test("reads who is assigned, with which roles, and who left", async () => {
    const { verdicts, requests } = await check(
      team,
      ["ada", "ben", "cleo", "dan", "eve", "frank"].map((name) => identity(name))
    )

    expect(verdicts).toEqual({
      "sub-ada": { status: "active", claims: { roles: ["Sixb.Admin"] } },
      // Assigned through a group.
      "sub-ben": { status: "active", claims: { roles: ["Sixb.Member"] } },
      // Disabled.
      "sub-cleo": { status: "inactive" },
      // Not assigned, and the app requires assignment.
      "sub-dan": { status: "inactive" },
      // Assigned without a role.
      "sub-eve": { status: "active", claims: { roles: [] } },
      // Deleted.
      "sub-frank": { status: "inactive" },
    })

    const token = requests[0]
    expect(token?.url.href).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`)
    expect(Object.fromEntries(new URLSearchParams(token?.body))).toEqual({
      grant_type: "client_credentials",
      client_id: "client-id",
      client_secret: "client-secret",
      scope: "https://graph.microsoft.com/.default",
    })
  })

  test("someone unassigned stays active when the app doesn't require assignment", async () => {
    const { verdicts } = await check({ ...team, assignmentRequired: false }, [identity("dan")])
    expect(verdicts).toEqual({ "sub-dan": { status: "active", claims: { roles: [] } } })
  })

  test("leaves out anyone it can't look up in this tenant", async () => {
    const { verdicts } = await check(team, [
      identity("ada", { tid: OTHER_TENANT }),
      identity("ben", { oid: undefined }),
      identity("cleo", { oid: "not-an-object-id" }),
    ])
    expect(verdicts).toEqual({})
  })

  test("looks people up 20 at a time", async () => {
    const names = Array.from({ length: 21 }, (_, index) => `p${String(index).padStart(2, "0")}`)
    const tenant: Tenant = {
      assignments: names.map((principal) => ({ principal, roleId: "role-member" })),
      accounts: Object.fromEntries(names.map((name) => [name, true])),
    }

    const { verdicts, requests } = await check(
      tenant,
      names.map((name) => identity(name))
    )

    expect(Object.keys(verdicts)).toHaveLength(21)
    expect(requests.filter(({ url }) => url.pathname === "/v1.0/$batch")).toHaveLength(2)
  })

  test("fails the whole check, and says which permissions it needs, when Graph refuses", async () => {
    const forbidden = await check(team, [identity("ada")], {
      graph: (url) =>
        url.pathname.includes("appRoleAssignedTo")
          ? Response.json(
              { error: { code: "Authorization_RequestDenied", message: "secret-ish" } },
              { status: 403 }
            )
          : undefined,
    }).catch((error: Error) => error.message)

    expect(forbidden).toBe(
      "[Sixb] Microsoft Graph answered 403: Authorization_RequestDenied to " +
        "/v1.0/servicePrincipals/sp-1/appRoleAssignedTo. Grant the app registration the Microsoft " +
        "Graph application permissions Application.Read.All and User.Read.All (and " +
        "GroupMember.Read.All when roles are assigned to groups), with admin consent."
    )
  })

  // Removal proof: skip users Graph refuses instead of throwing; the check then answers `{}`.
  test("fails the whole check when Graph refuses to look up one person", async () => {
    const message = await check({ ...team, accounts: { ...team.accounts, gil: "forbidden" } }, [
      identity("ada"),
      identity("gil"),
    ]).catch((error: Error) => error.message)

    expect(message).toBe(
      "[Sixb] Microsoft Graph answered 403: Authorization_RequestDenied to /v1.0/users/{id}. " +
        "Grant the app registration the Microsoft Graph application permissions " +
        "Application.Read.All and User.Read.All (and GroupMember.Read.All when roles are " +
        "assigned to groups), with admin consent."
    )
  })

  test("names Entra's error, never its description, when the token is refused", async () => {
    const refused = (async () =>
      Response.json(
        {
          error: "invalid_client",
          error_description: "AADSTS7000215: Invalid client secret provided. Trace ID: ...",
          error_codes: [7000215],
        },
        { status: 401 }
      )) as unknown as typeof fetch

    const message = await entraDirectory({ fetch: refused })
      .check({ app, identities: [identity("ada")], signal: AbortSignal.timeout(5_000) })
      .catch((error: Error) => error.message)

    expect(message).toBe(
      "[Sixb] entraDirectory could not get a Microsoft Graph token: invalid_client (AADSTS7000215)."
    )
  })

  test("follows next pages only on Graph", async () => {
    const message = await check(team, [identity("ada")], {
      graph: (url) =>
        url.pathname.includes("appRoleAssignedTo")
          ? Response.json({ value: [], "@odata.nextLink": "https://attacker.test/next" })
          : undefined,
    }).catch((error: Error) => error.message)

    expect(message).toBe(
      "[Sixb] Microsoft Graph sent a next page outside https://graph.microsoft.com for " +
        "/v1.0/servicePrincipals/sp-1/appRoleAssignedTo?$select=principalId,principalType,appRoleId&$top=999."
    )
  })

  test("needs the tenant's own issuer", async () => {
    for (const issuer of [
      "https://login.microsoftonline.com/common/v2.0",
      "https://login.microsoftonline.com/organizations/v2.0",
      `https://login.microsoftonline.com/${TENANT}`,
    ]) {
      const message = await entraDirectory({ fetch: fakeMicrosoft(team).fetch })
        .check({
          app: { ...app, issuer: new URL(issuer) },
          identities: [],
          signal: AbortSignal.timeout(1_000),
        })
        .catch((error: Error) => error.message)
      expect(message).toContain("entraDirectory needs your tenant's issuer")
    }
  })
})

describe("oidc({ directory })", () => {
  const admins = defineGroup("admins")
  const membersGroup = defineGroup("members")
  const appRoles: Record<string, GroupDefinition> = {
    "Sixb.Admin": admins,
    "Sixb.Member": membersGroup,
  }
  const groups = (claims: OidcClaims) => claims.roles?.flatMap((role) => appRoles[role] ?? []) ?? []
  const record = (name: string, claims: Record<string, unknown>): UserIdentityRecord => ({
    projectId: "project",
    strategyId: "oidc",
    subject: `sub-${name}`,
    userId: `usr_${name}`,
    claims: { sub: `sub-${name}`, ...claims },
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  // Removal proof: return `{ status: answer.status }` for every answer; Ada's groups vanish.
  test("turns the directory's roles into groups with the strategy's own mapping", async () => {
    const microsoft = fakeMicrosoft(team)
    const strategy = oidc({
      issuer: ISSUER,
      clientId: "client-id",
      clientSecret: "client-secret",
      groups,
      directory: entraDirectory({ fetch: microsoft.fetch, intervalMs: 15 * 60_000 }),
    })
    expect(strategy.directory?.intervalMs).toBe(15 * 60_000)

    const verdicts = await strategy.directory?.check({
      // Ada signed in as a member; she has since been made an admin.
      identities: [
        record("ada", { oid: oid("ada"), tid: TENANT, roles: ["Sixb.Member"] }),
        record("cleo", { oid: oid("cleo"), tid: TENANT }),
      ],
      signal: AbortSignal.timeout(5_000),
    })

    expect(Object.fromEntries(verdicts ?? [])).toEqual({
      "sub-ada": { status: "active", groupIds: ["admins"] },
      "sub-cleo": { status: "inactive" },
    })
  })

  test("without groups, an active verdict leaves groups alone", async () => {
    const strategy = oidc({
      issuer: ISSUER,
      clientId: "client-id",
      clientSecret: "client-secret",
      directory: entraDirectory({ fetch: fakeMicrosoft(team).fetch }),
    })

    const verdicts = await strategy.directory?.check({
      identities: [record("ada", { oid: oid("ada"), tid: TENANT })],
      signal: AbortSignal.timeout(5_000),
    })

    expect(Object.fromEntries(verdicts ?? [])).toEqual({ "sub-ada": { status: "active" } })
  })
})
