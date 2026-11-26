import { expect, test } from "bun:test"
import { branchAllowedTargets } from "../src/lib/branch-dev-env"

test("allows the HTTPS origins SIXB_BRANCH_ALLOW names", () => {
  expect(
    branchAllowedTargets(" https://redis.dev.shop.example/path , https://api.dev:8443")
  ).toEqual([
    { name: "redis.dev.shop.example", origin: "https://redis.dev.shop.example" },
    { name: "api.dev:8443", origin: "https://api.dev:8443" },
  ])
  expect(branchAllowedTargets(undefined)).toEqual([])
})

// `redis://…` once became the origin "null": the provider allowed nothing, and said nothing.
// Guard check: drop the protocol check from `branchAllowedTargets` (`branch-dev-env.ts`).
test.each([
  "redis://redis.dev:6379",
  "postgres://db.dev:5432",
  "nats://nats.dev:4222",
  "http://api.dev:8080",
])("refuses %s, which no sandbox can allow by name", (origin) => {
  expect(() => branchAllowedTargets(origin)).toThrow("allows https:// origins only")
})

test("refuses what is no URL", () => {
  expect(() => branchAllowedTargets("not an origin")).toThrow("which is no origin")
})
