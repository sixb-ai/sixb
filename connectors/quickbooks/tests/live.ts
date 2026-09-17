import { writeFile } from "node:fs/promises"
import { QuickBooksApiError, type QuickBooksRevision, quickbooks } from "../src"

const mode = process.env.QUICKBOOKS_LIVE
if (mode && !["read", "mutate", "webhook", "writes", "remaining-writes"].includes(mode))
  throw new Error("[QuickBooksLive] Invalid QUICKBOOKS_LIVE mode. See tests/README.md.")

export function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`[QuickBooksLive] Set ${name}. See tests/README.md.`)
  return value
}

export async function connect() {
  const token = required("QUICKBOOKS_ACCESS_TOKEN")
  const realmId = required("QUICKBOOKS_REALM_ID")
  const adapter = quickbooks({
    clientId: required("CLIENT_ID"),
    clientSecret: required("CLIENT_SECRET"),
    environment: "sandbox",
    timeoutMs: 20_000,
    minDelayMs: 250,
  })
  const context = {
    projectId: "live-test",
    connectorId: "quickbooks",
    signal: AbortSignal.timeout(15 * 60_000),
  }
  const [account] = await adapter.discoverAccounts(context, {
    accessToken: token,
    authorizationContext: { realmId },
  })
  if (!account) throw new Error("[QuickBooksLive] No sandbox company discovered")
  return {
    realmId,
    token,
    qb: await adapter.connect({
      ...context,
      connectionId: "sandbox",
      account,
      tokenSource: {
        async get() {
          return { accessToken: token, invalidate() {} }
        },
      },
    }),
  }
}

export function revision(row: { Id: string; SyncToken?: string }): QuickBooksRevision {
  if (!row.SyncToken) throw new Error("[QuickBooksLive] Missing SyncToken")
  return { Id: row.Id, SyncToken: row.SyncToken }
}

/** Separate journals and LIFO cleanup keep linked records recoverable after failures. */
export async function withJournal(
  name: string,
  run: (context: {
    qb: Awaited<ReturnType<typeof connect>>["qb"]
    tag: string
    write<T extends { Id: string }>(
      operation: string,
      input: unknown,
      send: (options: { requestId: string }) => Promise<T>
    ): Promise<T>
    defer(operation: string, cleanup: () => Promise<void>): void
  }) => Promise<void>
) {
  const { qb } = await connect()
  const path = `${required("QUICKBOOKS_JOURNAL")}.${name}.json`
  const tag = `Sixb-${crypto.randomUUID().slice(0, 16)}`
  const journal: {
    tag: string
    operations: {
      operation: string
      requestId: string
      input: unknown
      id?: string
      fault?: unknown
    }[]
    cleanup: { operation: string; complete: boolean }[]
  } = { tag, operations: [], cleanup: [] }
  await writeFile(path, JSON.stringify(journal), { flag: "wx", mode: 0o600 })
  const save = () => writeFile(path, JSON.stringify(journal), { mode: 0o600 })
  const cleanups: (() => Promise<void>)[] = []
  const failures: unknown[] = []
  try {
    await run({
      qb,
      tag,
      async write(operation, input, send) {
        const entry = {
          operation,
          input,
          requestId: crypto.randomUUID(),
          id: undefined as string | undefined,
          fault: undefined as unknown,
        }
        journal.operations.push(entry)
        await save()
        try {
          const result = await send({ requestId: entry.requestId })
          entry.id = result.Id
          await save()
          return result
        } catch (error) {
          if (error instanceof QuickBooksApiError) {
            entry.fault = { status: error.status, errors: error.errors, requestId: error.requestId }
            await save()
            console.error(`[QuickBooksLive] ${operation}: ${JSON.stringify(entry.fault)}`)
          }
          throw error
        }
      },
      defer(operation, cleanup) {
        const entry = { operation, complete: false }
        journal.cleanup.push(entry)
        cleanups.push(async () => {
          await cleanup()
          entry.complete = true
          await save()
        })
      },
    })
  } catch (error) {
    failures.push(error)
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
  }
  if (failures.length)
    throw new AggregateError(failures, `[QuickBooksLive] ${name} failed; inspect ${path}`)
}
