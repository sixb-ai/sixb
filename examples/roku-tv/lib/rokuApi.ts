import type { OntologySource, Pario } from "@pario/core"
import { rokuConnector } from "../connectors/roku"
import type { RokuApi } from "./roku/api"

export async function getRokuApi(
  pario: Pario<readonly OntologySource[]>,
  host: string
): Promise<RokuApi> {
  const client = await pario.connector(rokuConnector)
  return client.forHost(host)
}
