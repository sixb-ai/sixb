import { dir, file, type S4Route } from "@s4/provider-kit"
import type { ParioS4Api } from "../api"
import { JSON_CONTENT_TYPE } from "../constants"
import { directory, json, jsonFile } from "./helpers"

export function rootRoutes(api: ParioS4Api): readonly S4Route[] {
  return [
    dir("", {
      list: async () => [
        directory("ontology"),
        directory("objects"),
        directory("datasets"),
        directory("syncs"),
        jsonFile("status.json"),
      ],
    }),

    file("status.json", {
      contentType: JSON_CONTENT_TYPE,
      read: async () => json(await api.status()),
    }),
  ]
}
