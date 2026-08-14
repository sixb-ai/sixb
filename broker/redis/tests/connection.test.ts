import { expect, test } from "bun:test"
import { type RedisBrokerClient, RedisConnectionManager } from "../src/connection"

test("aborts a pending subscription client connection", async () => {
  let closeCount = 0
  let receivedOptions: object | undefined
  const client = fakeClient({
    connect: () => new Promise<void>(() => undefined),
    close: () => {
      closeCount += 1
    },
  })
  const manager = new RedisConnectionManager(
    {
      url: "redis://unused",
      autoReconnect: true,
      enableOfflineQueue: true,
    },
    (_url, options) => {
      receivedOptions = options
      return client
    }
  )
  const controller = new AbortController()

  const outcome = manager.createSubscriptionClient(controller.signal).then(
    () => undefined,
    (error: unknown) => error
  )
  await Promise.resolve()
  controller.abort()

  const error = await outcome
  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) throw new Error("Expected subscription connection to fail")
  expect(error.message).toContain("Failed to connect Redis subscription client")
  expect(closeCount).toBe(1)
  expect(receivedOptions).toMatchObject({
    autoReconnect: false,
    enableOfflineQueue: false,
  })
})

test("closing the manager aborts a subscription client that is still connecting", async () => {
  let closeCount = 0
  const client = fakeClient({
    connect: () => new Promise<void>(() => undefined),
    close: () => {
      closeCount += 1
    },
  })
  const manager = new RedisConnectionManager({}, () => client)

  const outcome = manager.createSubscriptionClient().then(
    () => undefined,
    (error: unknown) => error
  )
  await Promise.resolve()
  await manager.close()

  const error = await outcome
  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) throw new Error("Expected subscription connection to fail")
  expect(error.message).toContain("Failed to connect Redis subscription client")
  expect(closeCount).toBe(1)
})

function fakeClient(overrides: {
  readonly connect?: () => Promise<void>
  readonly close?: () => void
}): RedisBrokerClient {
  return {
    connect: overrides.connect ?? (async () => undefined),
    close: overrides.close ?? (() => undefined),
    exists: async () => false,
    hmget: async () => [],
    send: async () => null,
  }
}
