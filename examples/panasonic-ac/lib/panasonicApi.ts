import type { ActionRuntimeFacade } from "@sixb/core"
import { panasonicConnector } from "../connectors/panasonic"
import { PanasonicApiService } from "./panasonic/api"

type ConnectorRuntime = Pick<ActionRuntimeFacade, "connector">

/**
 * Resolve the Panasonic connector and return a typed API service.
 *
 * The underlying `RestClient` is lazily connected and cached by the Sixb
 * connector runtime, so calling this multiple times is cheap.
 */
export async function getPanasonicApi(sixb: ConnectorRuntime): Promise<PanasonicApiService> {
  const client = await sixb.connector(panasonicConnector)
  return new PanasonicApiService(client)
}
