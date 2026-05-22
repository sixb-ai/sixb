import type { S4Provider } from "@s4/core"
import { createRouteProvider } from "@s4/provider-kit"
import type { ParioS4Api } from "../api"
import { datasetRoutes } from "./datasets"
import { objectRoutes } from "./objects"
import { ontologyRoutes } from "./ontology"
import { rootRoutes } from "./root"
import { syncRoutes } from "./syncs"

export function createParioS4RouteProvider(api: ParioS4Api): S4Provider {
  return createRouteProvider({
    id: "pario",
    routes: [
      ...rootRoutes(api),
      ...ontologyRoutes(api),
      ...objectRoutes(api),
      ...datasetRoutes(api),
      ...syncRoutes(api),
    ],
  })
}
