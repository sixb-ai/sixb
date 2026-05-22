import type { OntologySource, Pario } from "@pario/core"
import { panasonicConnector } from "../connectors/panasonic"
import { PanasonicApiService } from "./panasonic/api"

/**
 * Resolve the Panasonic connector and return a typed API service.
 *
 * The underlying `RestClient` is lazily connected and cached by the Pario
 * connector runtime, so calling this multiple times is cheap.
 */
export async function getPanasonicApi(
  pario: Pario<readonly OntologySource[]>
): Promise<PanasonicApiService> {
  const client = await pario.connector(panasonicConnector)
  return new PanasonicApiService(client)
}
