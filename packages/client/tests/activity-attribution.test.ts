import { expect, test } from "bun:test"
import { ActivityArrival, readActivityAttribution } from "../src/activity-attribution"

const api = "https://api.example.test"

function read(query = "", referrer = "") {
  return readActivityAttribution(`https://app.example.test/invoices?${query}#secret`, referrer, api)
}

function storage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
    removeItem: (key: string) => {
      data.delete(key)
    },
  }
}

test("UTMs come first, then an external referrer, else direct; never a URL", () => {
  expect(
    read(
      "utm_source=newsletter&utm_medium=email&utm_campaign=Launch&token=secret",
      "https://partner.test/private?secret=1"
    )
  ).toEqual({ source: "newsletter", medium: "email", campaign: "Launch" })
  expect(read("utm_medium=email")).toEqual({ medium: "email" })
  expect(read("utm_source=%20newsletter%20")).toEqual({ source: "newsletter" })

  expect(read("", "https://name:password@PARTNER.test:443/path?token=secret#fragment")).toEqual({
    referrer: "partner.test",
  })
  expect(read("", "https://app.example.test/other")).toEqual({})
  expect(read("", `${api}/auth/callback`)).toEqual({})
  expect(read("", "javascript:alert(1)")).toEqual({})
  expect(read()).toEqual({})

  // A malformed campaign is not collected, rather than passed off as a direct arrival.
  expect(read(`utm_source=${"x".repeat(101)}`)).toBeUndefined()
  expect(read("utm_source=bad%0Alabel")).toBeUndefined()
})

// Guard proof: ignore the stored arrival in ActivityArrival; the sign-in provider becomes the
// referrer instead of the partner.
test("a Sixb redirect keeps the arrival once, for its own authority, for a limited time", () => {
  const store = storage()
  const key = "api:app"
  const arrival = new ActivityArrival(
    store,
    key,
    read("", "https://partner.test/private?secret=yes"),
    () => 1_000
  )
  expect(store.getItem(key)).toBeNull()

  arrival.preserve()
  expect(store.getItem(key)).not.toContain("secret")
  expect(new ActivityArrival(store, "api:share:g", {}, () => 2_000).attribution).toEqual({})

  const restored = new ActivityArrival(store, key, { referrer: "identity.test" }, () => 2_000)
  expect(restored.attribution).toEqual({ referrer: "partner.test" })
  expect(store.getItem(key)).toBeNull()
  expect(new ActivityArrival(store, key, {}, () => 3_000).attribution).toEqual({})

  arrival.preserve()
  expect(new ActivityArrival(store, key, {}, () => 1_000 + 30 * 60_000).attribution).toEqual({})

  arrival.preserve()
  const fresh = new ActivityArrival(store, key, { source: "fresh-link" }, () => 2_000)
  expect(fresh.attribution).toEqual({ source: "fresh-link" })
})

test("blocked or tampered storage cannot break arrival or leak unrecognized data", () => {
  const blocked = {
    getItem() {
      throw Error("blocked")
    },
    setItem() {
      throw Error("blocked")
    },
    removeItem() {
      throw Error("blocked")
    },
  }
  const arrival = new ActivityArrival(blocked, "key", { source: "newsletter" })
  expect(arrival.attribution).toEqual({ source: "newsletter" })
  expect(() => arrival.preserve()).not.toThrow()

  const store = storage()
  for (const attribution of [
    { referrer: "https://partner.test/private" },
    { source: "ok", secret: "private" },
    { source: 123 },
    { source: "\n" },
  ]) {
    store.setItem("key", JSON.stringify({ at: 1_000, attribution }))
    expect(new ActivityArrival(store, "key", {}, () => 2_000).attribution).toEqual({})
  }
})
