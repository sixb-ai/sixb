import type { MondayHttp } from "./http"
import { boardResources } from "./resources/boards"
import { itemResources } from "./resources/items"
import { supportingResources } from "./resources/supporting"

export function createMondayClient(http: MondayHttp) {
  return { ...boardResources(http), ...itemResources(http), ...supportingResources(http) }
}
