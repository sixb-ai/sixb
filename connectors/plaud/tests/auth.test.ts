import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PlaudAuthError, plaud } from "../src"
import { plaudFileTokenStore } from "../src/auth"
import { createTokenSource } from "../src/oauth"
import { context, details, json, memoryStore, mockFetch } from "./helpers"

const originalFetch = globalThis.fetch
const directories: string[] = []
afterEach(async () => {
  globalThis.fetch = originalFetch
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})
const expired = () => ({
  access_token: "old",
  refresh_token: "refresh-1",
  expires_at: Date.now() - 1_000,
})

test("missing tokens explain how to authorize", async () => {
  await expect(
    createTokenSource({ tokenStore: memoryStore(null) }, context.signal).get()
  ).rejects.toThrow("loginPlaud")
})
test("refreshes once for concurrent clients, persists rotated credentials before use", async () => {
  const store = memoryStore(expired())
  let calls = 0
  mockFetch(async (url, init) => {
    calls++
    expect(url.pathname).toBe("/developer/api/oauth/third-party/access-token/refresh")
    expect(new URLSearchParams(String(init.body)).get("refresh_token")).toBe("refresh-1")
    expect(new Headers(init.headers).has("authorization")).toBe(false)
    expect((await store.load())?.refresh_pending).toBe(true)
    return json({
      access_token: "new",
      refresh_token: "refresh-2",
      token_type: "Bearer",
      expires_in: 3600,
    })
  })
  const a = createTokenSource({ tokenStore: store }, context.signal)
  const b = createTokenSource({ tokenStore: store }, context.signal)
  const values = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).get()))
  expect(values.every((v) => v.accessToken === "new")).toBe(true)
  expect(calls).toBe(1)
  expect(await store.load()).toMatchObject({ access_token: "new", refresh_token: "refresh-2" })
  expect((await store.load())?.refresh_pending).toBeUndefined()
})
test("401 refresh retries only once and invalidates the rejected token", async () => {
  // Guard check: remove onUnauthorized in src/http.ts; this test must fail on the first 401.
  const store = memoryStore({ access_token: "old", refresh_token: "refresh-1" })
  let api = 0
  let refresh = 0
  mockFetch((url, init) => {
    if (url.pathname.endsWith("/refresh")) {
      refresh++
      return json({ access_token: "new", expires_in: 3600 })
    }
    api++
    return new Headers(init.headers).get("authorization") === "Bearer old"
      ? json({}, 401)
      : json(details())
  })
  const client = await plaud({ tokenStore: store }).connect(context)
  await client.recordings.get("r1")
  expect(api).toBe(2)
  expect(refresh).toBe(1)
  expect((await store.load())?.refresh_token).toBe("refresh-1")
})
test("late rejection of an old access token cannot rotate the new token again", async () => {
  const store = memoryStore({ access_token: "old", refresh_token: "refresh-1" })
  let count = 0
  mockFetch(() => {
    count++
    return json({ access_token: "new", refresh_token: "refresh-2", expires_in: 3600 })
  })
  const source = createTokenSource({ tokenStore: store }, context.signal)
  const [a, b] = await Promise.all([source.get(), source.get()])
  a.invalidate()
  await source.get()
  b.invalidate()
  expect((await source.get()).accessToken).toBe("new")
  expect(count).toBe(1)
})
test("a second 401 is surfaced, with no refresh loop", async () => {
  let count = 0
  mockFetch((url) => {
    count++
    return url.pathname.endsWith("/refresh")
      ? json({ access_token: "new", expires_in: 3600 })
      : json({}, 401)
  })
  const client = await plaud({ tokenStore: memoryStore() }).connect(context)
  await expect(client.recordings.get("r1")).rejects.toThrow("HTTP 401")
  expect(count).toBe(3)
})
test("uncertain refresh is durably fenced, even for a new client", async () => {
  const store = memoryStore(expired())
  let calls = 0
  mockFetch(() => {
    calls++
    throw new Error("network includes a secret URL")
  })
  const client = await plaud({ tokenStore: store }).connect(context)
  await expect(client.recordings.get("r1")).rejects.toBeInstanceOf(PlaudAuthError)
  expect((await store.load())?.refresh_pending).toBe(true)
  await expect(createTokenSource({ tokenStore: store }, context.signal).get()).rejects.toThrow(
    "uncertain"
  )
  expect(calls).toBe(1)
})
test("failed persistence after rotation never returns an undurable token", async () => {
  const store = memoryStore(expired())
  const save = store.save
  store.save = async (tokens) => {
    if (tokens.access_token === "new") throw new Error("disk full")
    await save(tokens)
  }
  mockFetch(() => json({ access_token: "new", refresh_token: "refresh-2", expires_in: 3600 }))
  await expect(createTokenSource({ tokenStore: store }, context.signal).get()).rejects.toThrow(
    "safely"
  )
  expect((await store.load())?.refresh_pending).toBe(true)
})
test("rate limiting preserves credentials and allows a later refresh", async () => {
  const store = memoryStore(expired())
  mockFetch(() => json({}, 429))
  const source = createTokenSource({ tokenStore: store }, context.signal)
  await expect(source.get()).rejects.toThrow("HTTP 429")
  expect((await store.load())?.refresh_pending).toBeUndefined()
  mockFetch(() => json({ access_token: "new", expires_in: 3600 }))
  expect((await source.get()).accessToken).toBe("new")
})
test("rejected and malformed refreshes require reauthorization without secret leakage", async () => {
  for (const response of [
    () => json({ message: "secret" }, 401),
    () => json({ access_token: "secret", expires_in: -5 }),
    () => json({ access_token: "secret", token_type: "Basic" }),
  ]) {
    mockFetch(response)
    const source = createTokenSource({ tokenStore: memoryStore(expired()) }, context.signal)
    try {
      await source.get()
      throw new Error("expected failure")
    } catch (error) {
      expect(error).toBeInstanceOf(PlaudAuthError)
      expect(String(error)).not.toContain("secret")
    }
  }
})
test("JWT expiry is used when expires_at is absent", async () => {
  const access = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`
  mockFetch(() => json({ access_token: "new", expires_in: 3600 }))
  expect(
    (
      await createTokenSource(
        { tokenStore: memoryStore({ access_token: access, refresh_token: "r" }) },
        context.signal
      ).get()
    ).accessToken
  ).toBe("new")
})
test("file store writes atomically with restricted permissions and coordinates separate instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sixb-plaud-"))
  directories.push(dir)
  const path = join(dir, "tokens.json")
  const a = plaudFileTokenStore(path)
  const b = plaudFileTokenStore(path)
  expect(await a.load()).toBeNull()
  await a.save(expired())
  let refreshes = 0
  mockFetch(() => {
    refreshes++
    return json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 })
  })
  await Promise.all(
    [a, b].map((tokenStore) => createTokenSource({ tokenStore }, context.signal).get())
  )
  expect(refreshes).toBe(1)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(JSON.parse(await readFile(path, "utf8")).refresh_token).toBe("rotated")
  expect(await readdir(dir)).toEqual(["tokens.json"])
})
test("abort releases file locks without touching credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sixb-plaud-"))
  directories.push(dir)
  const store = plaudFileTokenStore(join(dir, "tokens.json"))
  await store.save({ access_token: "saved" })
  await expect(store.withLock(async () => {}, AbortSignal.abort())).rejects.toThrow()
  expect((await store.load())?.access_token).toBe("saved")
  expect(await readdir(dir)).toEqual(["tokens.json"])
})
