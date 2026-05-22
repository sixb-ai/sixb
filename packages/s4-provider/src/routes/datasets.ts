import { dir, file, type S4Route } from "@s4/provider-kit"
import type { ParioS4Api } from "../api"
import { JSON_CONTENT_TYPE } from "../constants"
import { decodeSegment, directory, json, jsonFile, segment } from "./helpers"

export function datasetRoutes(api: ParioS4Api): readonly S4Route[] {
  return [
    dir("datasets", {
      list: async () => [
        jsonFile("datasets/index.json"),
        ...(await api.listDatasets()).map((dataset) =>
          directory(`datasets/${segment(dataset.id)}`)
        ),
      ],
    }),

    file("datasets/index.json", {
      contentType: JSON_CONTENT_TYPE,
      read: async () => json(await api.listDatasets()),
    }),

    dir("datasets/:datasetId", {
      list: async ({ params }) => [
        jsonFile(`datasets/${params.datasetId}/schema.json`),
        directory(`datasets/${params.datasetId}/versions`),
      ],
    }),

    file("datasets/:datasetId/schema.json", {
      contentType: JSON_CONTENT_TYPE,
      read: async ({ params }) => json(await api.getDataset(decodeSegment(params.datasetId))),
    }),

    dir("datasets/:datasetId/versions", {
      list: async ({ params }) => {
        const versions = await api.listDatasetVersions(decodeSegment(params.datasetId))
        return [
          jsonFile(`datasets/${params.datasetId}/versions/index.json`),
          ...versions.versions.map((version) =>
            directory(`datasets/${params.datasetId}/versions/${segment(version.versionId)}`)
          ),
        ]
      },
    }),

    file("datasets/:datasetId/versions/index.json", {
      contentType: JSON_CONTENT_TYPE,
      read: async ({ params }) =>
        json(await api.listDatasetVersions(decodeSegment(params.datasetId))),
    }),

    dir("datasets/:datasetId/versions/:versionId", {
      list: async ({ params }) => [
        jsonFile(`datasets/${params.datasetId}/versions/${params.versionId}/version.json`),
      ],
    }),

    file("datasets/:datasetId/versions/:versionId/version.json", {
      contentType: JSON_CONTENT_TYPE,
      read: async ({ params }) =>
        json(
          await api.getDatasetVersion(
            decodeSegment(params.datasetId),
            decodeSegment(params.versionId)
          )
        ),
    }),
  ]
}
