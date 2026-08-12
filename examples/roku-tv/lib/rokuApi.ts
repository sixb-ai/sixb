import type { ActionRuntimeFacade } from "@sixb/core"
import { rokuConnector } from "../connectors/roku"
import type { RokuApi } from "./roku/api"

type ConnectorAccess = Pick<ActionRuntimeFacade, "connector">

export async function getRokuApi(sixb: ConnectorAccess, host: string): Promise<RokuApi> {
  const client = await sixb.connector(rokuConnector)
  return client.forHost(host)
}
