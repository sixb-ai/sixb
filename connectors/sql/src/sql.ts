import { SQL } from "bun"
import type { SqlClient, SqlConnection, SqlConnector } from "./types"

/**
 * Create a SQL connector backed by Bun.SQL.
 *
 * The connected client is the native Bun SQL client, so PostgreSQL, MySQL,
 * and SQLite all share the same runtime shape.
 */
export function sql(connection: SqlConnection): SqlConnector {
  assertConnection(connection)

  return {
    type: "sql",
    connect() {
      if (typeof connection === "string" || connection instanceof URL) {
        return new SQL(connection)
      }

      return new SQL(connection)
    },
    async disconnect(client: SqlClient) {
      await client.close()
    },
  }
}

function assertConnection(connection: SqlConnection): void {
  if (typeof connection === "string" && !connection.trim()) {
    throw new Error("[SixbSql] connection must not be empty.")
  }
}
