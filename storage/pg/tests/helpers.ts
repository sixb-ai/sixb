import { migrateStorage } from "@sixb/core"
import { PostgresStorage } from "../src"

export interface TestStorageOptions {
  migrate?: boolean
}

/**
 * Creates a PostgresStorage instance for testing.
 * Requires DATABASE_URL to be set (handled by tests/setup.ts preload).
 * Each call uses a unique schema to enable parallel test execution.
 */
export async function createTestStorage(
  options: TestStorageOptions = {}
): Promise<{ storage: PostgresStorage; schemaName: string }> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      "[SixbPg] DATABASE_URL is required. Run `bun run test:e2e` from the @sixb/pg package."
    )
  }

  // Use a unique schema per test to avoid collisions
  const schemaName = `sixb_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  const storage = new PostgresStorage({
    connectionString,
    schemaName,
    max: 5,
  })

  if (options.migrate ?? true) {
    await migrateStorage(storage)
  }

  return { storage, schemaName }
}
