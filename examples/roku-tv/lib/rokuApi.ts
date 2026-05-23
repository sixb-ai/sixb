import type { OntologySource, Sixb } from "@sixb/core"
import { rokuConnector } from "../connectors/roku"
import type { RokuApi } from "./roku/api"

export async function getRokuApi(
  sixb: Sixb<readonly OntologySource[]>,
  host: string
): Promise<RokuApi> {
  const client = await sixb.connector(rokuConnector)
  return client.forHost(host)
}
