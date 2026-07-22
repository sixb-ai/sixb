import {
  runMaterializationFailureContractSuite,
  runMaterializerStorageContractSuite,
  runOntologyStorageContractSuite,
} from "@sixb/core/testing"
import postgres from "postgres"
import type { PostgresStorage } from "../src"
import { quoteIdent } from "../src/migrations"
import { createTestStorage } from "./helpers"

runOntologyStorageContractSuite("PostgreSQL ontology storage contract", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: cleanupStorage,
})

runMaterializerStorageContractSuite("PostgreSQL materializer storage contract", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: cleanupStorage,
})

interface FailureStorage extends PostgresStorage {
  readonly testSchemaName: string
}

runMaterializationFailureContractSuite("PostgreSQL materialization failure contract", {
  async createStorage(): Promise<FailureStorage> {
    const { storage, schemaName } = await createTestStorage()
    Object.defineProperty(storage, "testSchemaName", { value: schemaName })
    return storage as FailureStorage
  },
  cleanup: cleanupStorage,
  captureState(storage) {
    return withDatabase(storage.testSchemaName, async (sql, schema) => ({
      objects: await sql.unsafe(
        `SELECT * FROM ${schema}.objects ORDER BY project_id, object_type_id, primary_id`
      ),
      commits: await sql.unsafe(`SELECT * FROM ${schema}.ontology_commits ORDER BY project_id, id`),
      outbox: await sql.unsafe(`SELECT * FROM ${schema}.ontology_outbox ORDER BY project_id, id`),
    }))
  },
  injectFailure(storage, boundary, failure) {
    const table =
      boundary === "effective.object.upsert"
        ? "objects"
        : boundary === "outbox.insert"
          ? "ontology_outbox"
          : "ontology_commits"
    return withDatabase(storage.testSchemaName, async (sql, schema) => {
      await sql.unsafe(`
        CREATE FUNCTION ${schema}.ontology_contract_failure() RETURNS trigger AS $failure$
        BEGIN
          RAISE EXCEPTION '${failure.message.replaceAll("'", "''")}';
        END;
        $failure$ LANGUAGE plpgsql;
        CREATE TRIGGER ontology_contract_failure
          BEFORE INSERT ON ${schema}.${table}
          FOR EACH ROW EXECUTE FUNCTION ${schema}.ontology_contract_failure();
      `)
    })
  },
  clearFailure(storage) {
    return withDatabase(storage.testSchemaName, async (sql, schema) => {
      for (const table of ["objects", "ontology_outbox", "ontology_commits"]) {
        await sql.unsafe(`DROP TRIGGER IF EXISTS ontology_contract_failure ON ${schema}.${table}`)
      }
      await sql.unsafe(`DROP FUNCTION IF EXISTS ${schema}.ontology_contract_failure()`)
    })
  },
})

async function cleanupStorage(storage: PostgresStorage): Promise<void> {
  await storage.dropSchema()
  await storage.close()
}

async function withDatabase<T>(
  schemaName: string,
  run: (sql: postgres.Sql, schema: string) => Promise<T>
): Promise<T> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("[SixbPg] DATABASE_URL is required for ontology tests.")
  const sql = postgres(connectionString, { max: 1, onnotice: () => undefined })
  try {
    return await run(sql, quoteIdent(schemaName))
  } finally {
    await sql.end()
  }
}
