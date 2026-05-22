import { dir, file, type S4Route } from "@s4/provider-kit"
import type { ParioS4Api } from "../api"
import { JSON_CONTENT_TYPE } from "../constants"
import { decodeSegment, directory, json, jsonFile, segment } from "./helpers"

export function syncRoutes(api: ParioS4Api): readonly S4Route[] {
  return [
    dir("syncs", {
      list: async () => [
        jsonFile("syncs/index.json"),
        ...(await api.listSyncs()).map((sync) => directory(`syncs/${segment(sync.id)}`)),
      ],
    }),

    file("syncs/index.json", {
      contentType: JSON_CONTENT_TYPE,
      read: async () => json(await api.listSyncs()),
    }),

    dir("syncs/:syncId", {
      list: async ({ params }) => [
        jsonFile(`syncs/${params.syncId}/definition.json`),
        directory(`syncs/${params.syncId}/runs`),
      ],
    }),

    file("syncs/:syncId/definition.json", {
      contentType: JSON_CONTENT_TYPE,
      read: async ({ params }) => json(await api.getSync(decodeSegment(params.syncId))),
    }),

    dir("syncs/:syncId/runs", {
      list: async ({ params }) => [jsonFile(`syncs/${params.syncId}/runs/index.json`)],
    }),

    file("syncs/:syncId/runs/index.json", {
      contentType: JSON_CONTENT_TYPE,
      read: async ({ params }) => json(await api.listSyncRuns(decodeSegment(params.syncId))),
    }),
  ]
}
