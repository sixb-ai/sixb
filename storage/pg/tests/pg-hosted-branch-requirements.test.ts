import { expect, test } from "bun:test"
import { type HostedBranchHostFacts, hostedBranchRequirement } from "../src/hosted-branches"

// What production's instance must be before it hosts a branch, judged from what PostgreSQL says
// of it. `pg-hosted-branches.e2e.ts` reads the facts from a real instance; these are the ones a
// test instance cannot be switched to without a restart.

const ready: HostedBranchHostFacts = {
  user: "doadmin",
  superuser: false,
  createrole: true,
  createdb: true,
  version: 170_000,
  database: "defaultdb",
  publicConnect: false,
  maxPreparedTransactions: 0,
  maxConnections: 100,
  maxLocksPerTransaction: 64,
}

test("hosts branches on an instance that holds every requirement", () => {
  expect(hostedBranchRequirement(ready)).toBeNull()
  expect(hostedBranchRequirement({ ...ready, objectTypes: 60 })).toBeNull()
})

// Only its owner or a superuser finishes a prepared transaction, and its owner, the branch, may
// keep production out of its database: one it left would hold its locks for good.
// Guard check: drop the `maxPreparedTransactions` clause from `hostedBranchRequirement`.
test("refuses an instance that lets sessions prepare transactions", () => {
  expect(hostedBranchRequirement({ ...ready, maxPreparedTransactions: 10 })).toBe(
    "max_prepared_transactions = 0 on production's instance (it is 10): a transaction a branch prepared would outlive its session, with its locks, beyond production's reach. The framework never prepares one: set it to 0 and restart PostgreSQL"
  )
})

// Guard check: drop the `objectTypes` clause from `hostedBranchRequirement`.
test("says how large a lock table a copy of many types needs", () => {
  expect(hostedBranchRequirement({ ...ready, objectTypes: 400 })).toBe(
    "a larger lock table for a copy of 400 object types: its load holds about 8120 locks, more than a branch's quarter of the table (1600). Set max_locks_per_transaction = 384 and restart PostgreSQL"
  )
  expect(
    hostedBranchRequirement({ ...ready, objectTypes: 400, maxLocksPerTransaction: 384 })
  ).toBeNull()
})

test("names each attribute production's user lacks, and the statement that gives it", () => {
  expect(hostedBranchRequirement({ ...ready, createrole: false, createdb: false })).toContain(
    `As a superuser: ALTER ROLE "doadmin" CREATEROLE CREATEDB`
  )
  expect(hostedBranchRequirement({ ...ready, version: 150_000 })).toBe("PostgreSQL 16 or later")
})
