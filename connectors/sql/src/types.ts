import type { ConnectorAdapter } from "@pario/core"
import type { SQL } from "bun"

type SqlOptions = import("bun").SQL.Options

export type SqlConnection = string | URL | SqlOptions

export type SqlClient = SQL
export type SqlConnector = ConnectorAdapter<"sql", SqlClient>
