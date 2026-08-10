import { afterEach, expect, test } from "bun:test"
import { createTestClient, json, jsonBody, originalFetch, query, recorder } from "./helpers"

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("people search posts the copied URL with account pagination", async () => {
  const calls = recorder([
    json({
      object: "LinkedinSearch",
      items: [{ type: "PEOPLE", id: "ACo1", name: "Ada Lovelace" }],
      config: { params: { api: "classic", category: "people" } },
      paging: { start: 0, page_count: 1, total_count: 1 },
      cursor: "search-next",
    }),
  ])
  const client = await createTestClient()
  const searchUrl = "https://www.linkedin.com/search/results/people/?keywords=founder"

  const page = await client.linkedin.searchPeople({
    account_id: "account-1",
    url: searchUrl,
    limit: 25,
    cursor: "search-cursor",
  })

  expect(page.items[0]?.id).toBe("ACo1")
  expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v1/linkedin/search")
  expect(query(calls[0]?.url ?? "").get("account_id")).toBe("account-1")
  expect(query(calls[0]?.url ?? "").get("limit")).toBe("25")
  expect(query(calls[0]?.url ?? "").get("cursor")).toBe("search-cursor")
  expect(jsonBody(calls[0] as NonNullable<(typeof calls)[number]>)).toEqual({ url: searchUrl })
})

test("people search accepts Sales Navigator and Recruiter people-search URLs", async () => {
  const calls = recorder(() =>
    json({
      object: "LinkedinSearch",
      items: [],
      config: { params: { category: "people" } },
      paging: { start: 0, page_count: 0, total_count: 0 },
      cursor: null,
    })
  )
  const client = await createTestClient()
  const urls = [
    "https://www.linkedin.com/sales/search/people?query=founder",
    "https://www.linkedin.com/talent/search?keywords=engineer",
  ]

  await Promise.all(
    urls.map((url) => client.linkedin.searchPeople({ account_id: "account-1", url }))
  )

  expect(calls).toHaveLength(2)
})

test("people search rejects non-LinkedIn URLs", async () => {
  const client = await createTestClient()

  expect(() =>
    client.linkedin.searchPeople({
      account_id: "account-1",
      url: "https://example.com/search",
    })
  ).toThrow("must use linkedin.com")
})

test("people search rejects LinkedIn searches for non-people categories", async () => {
  // Regression: hostname-only validation accepts these URLs and gives a people-only return type to
  // company, job, or post payloads.
  const client = await createTestClient()
  const urls = [
    "https://www.linkedin.com/search/results/companies/?keywords=sixb",
    "https://www.linkedin.com/jobs/search/?keywords=engineer",
    "https://www.linkedin.com/search/results/content/?keywords=outreach",
    "https://www.linkedin.com/sales/search/company?query=sixb",
  ]

  for (const url of urls) {
    expect(() => client.linkedin.searchPeople({ account_id: "account-1", url })).toThrow(
      "must represent a people search"
    )
  }
})

test("getProfile encodes the identifier and selected sections", async () => {
  const calls = recorder([
    json({
      object: "UserProfile",
      provider: "LINKEDIN",
      provider_id: "ACo1",
      public_identifier: "ada-lovelace",
      first_name: "Ada",
      last_name: "Lovelace",
      headline: "Founder",
    }),
  ])
  const client = await createTestClient()

  const profile = await client.users.getProfile("ada/lovelace", {
    account_id: "account-1",
    linkedin_api: "sales_navigator",
    linkedin_sections: ["*_preview", "experience"],
    notify: false,
  })

  expect(profile.provider_id).toBe("ACo1")
  expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v1/users/ada%2Flovelace")
  expect(query(calls[0]?.url ?? "").get("account_id")).toBe("account-1")
  expect(query(calls[0]?.url ?? "").get("linkedin_api")).toBe("sales_navigator")
  expect(query(calls[0]?.url ?? "").get("linkedin_sections")).toBe("*_preview,experience")
  expect(query(calls[0]?.url ?? "").get("notify")).toBe("false")
})

test("sendInvitation preserves upstream fields", async () => {
  const calls = recorder([json({ object: "UserInvitationSent", invitation_id: "invite-1" })])
  const client = await createTestClient()

  const invitation = await client.users.sendInvitation({
    account_id: "account-1",
    provider_id: "ACo1",
    user_email: "ada@example.com",
    message: "Hello Ada",
  })

  expect(invitation.invitation_id).toBe("invite-1")
  expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v1/users/invite")
  expect(jsonBody(calls[0] as NonNullable<(typeof calls)[number]>)).toEqual({
    account_id: "account-1",
    provider_id: "ACo1",
    user_email: "ada@example.com",
    message: "Hello Ada",
  })
})

test("sendInvitation rejects notes over 300 Unicode characters", async () => {
  const client = await createTestClient()

  expect(() =>
    client.users.sendInvitation({
      account_id: "account-1",
      provider_id: "ACo1",
      message: "🙂".repeat(301),
    })
  ).toThrow("at most 300 characters")
})

test("listRelations sends only an explicit page and account", async () => {
  const calls = recorder([
    json({ object: "UserRelationsList", items: [], cursor: "relations-next" }),
  ])
  const client = await createTestClient()

  const page = await client.users.listRelations({
    account_id: "account-1",
    limit: 100,
    cursor: "relations-cursor",
  })

  expect(page.cursor).toBe("relations-next")
  expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v1/users/relations")
  expect(query(calls[0]?.url ?? "").get("account_id")).toBe("account-1")
  expect(query(calls[0]?.url ?? "").get("limit")).toBe("100")
  expect(query(calls[0]?.url ?? "").get("cursor")).toBe("relations-cursor")
})
