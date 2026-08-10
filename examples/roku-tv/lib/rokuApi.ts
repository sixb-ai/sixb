import type { ActionRuntimeFacade } from "@sixb/core"
import { rokuConnector } from "../connectors/roku"
import type { RokuApi } from "./roku/api"

type ConnectorRuntime = Pick<ActionRuntimeFacade, "connectors">

export async function getRokuApi(sixb: ConnectorRuntime, host: string): Promise<RokuApi> {
  const client = await sixb.connectors.connect(rokuConnector)
  return client.forHost(host)
}
