import { dir, file, type S4Route } from "@s4/provider-kit"
import type { ParioS4Api } from "../api"
import { JSON_CONTENT_TYPE } from "../constants"
import { json, jsonFile } from "./helpers"

export function ontologyRoutes(api: ParioS4Api): readonly S4Route[] {
  return [
    dir("ontology", {
      list: async () => [jsonFile("ontology/index.json")],
    }),

    file("ontology/index.json", {
      contentType: JSON_CONTENT_TYPE,
      read: async () => json(await api.listObjectTypes()),
    }),
  ]
}
