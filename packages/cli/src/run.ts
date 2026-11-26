import { ApiClient } from "./api-client"
import { dispatch } from "./commands"

export interface ApiConnection {
  readonly baseUrl: string
  readonly token?: string
  /** Names the acting run when a child speaks through its parent's credential: `SIXB_RUN_ID`. */
  readonly runId?: string
}

export interface RunInstanceCliInput {
  readonly args: readonly string[]
  readonly connection: ApiConnection
}

export async function runInstanceCli(input: RunInstanceCliInput): Promise<void> {
  const [command, ...args] = input.args
  await dispatch(createInstanceApiClient(input.connection), command ?? "", args)
}

export function createInstanceApiClient(connection: ApiConnection): ApiClient {
  return new ApiClient({
    baseUrl: connection.baseUrl,
    ...(connection.token ? { authorization: `Bearer ${connection.token}` } : {}),
    ...(connection.runId ? { runId: connection.runId } : {}),
  })
}
