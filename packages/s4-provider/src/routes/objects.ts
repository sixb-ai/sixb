import { type S4InvokeResult, S4NotFoundError } from "@s4/core"
import { action, dir, file, type S4Route } from "@s4/provider-kit"
import type { ParioS4Api } from "../api"
import { JSON_CONTENT_TYPE } from "../constants"
import { actionParamsToJsonSchema } from "../json-schema"
import { actionEntry, decodeSegment, directory, json, jsonFile, segment } from "./helpers"

type ActionDef = {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly params?: readonly { readonly id: string }[]
}

export function objectRoutes(api: ParioS4Api): readonly S4Route[] {
  return [
    dir("objects", {
      list: async () => [
        jsonFile("objects/index.json"),
        ...(await api.listObjectTypes()).map((objectType) =>
          directory(`objects/${segment(objectType.id)}`)
        ),
      ],
    }),

    file("objects/index.json", {
      contentType: JSON_CONTENT_TYPE,
      read: async () => json(await api.listObjectTypes()),
    }),

    dir("objects/:objectTypeId", {
      list: async ({ params }) => {
        const result = await api.listObjects(decodeSegment(params.objectTypeId))
        return [
          jsonFile(`objects/${params.objectTypeId}/index.json`),
          ...result.objects.map((object) =>
            directory(`objects/${params.objectTypeId}/${segment(object.primaryId)}`)
          ),
        ]
      },
    }),

    file("objects/:objectTypeId/index.json", {
      contentType: JSON_CONTENT_TYPE,
      read: async ({ params }) => {
        const objectTypeId = decodeSegment(params.objectTypeId)
        const result = await api.listObjects(objectTypeId)
        return json({
          objectTypeId,
          hasMore: result.hasMore,
          total: result.total,
          objects: result.objects.map((object) => ({
            primaryId: object.primaryId,
            objectTypeId: object.objectTypeId,
          })),
        })
      },
    }),

    dir("objects/:objectTypeId/:primaryId", {
      list: async ({ params }) => [
        jsonFile(`objects/${params.objectTypeId}/${params.primaryId}/object.json`),
        jsonFile(`objects/${params.objectTypeId}/${params.primaryId}/links.json`),
        directory(`objects/${params.objectTypeId}/${params.primaryId}/actions`),
      ],
    }),

    file("objects/:objectTypeId/:primaryId/object.json", {
      contentType: JSON_CONTENT_TYPE,
      read: async ({ params }) =>
        json(
          await api.getObject(decodeSegment(params.objectTypeId), decodeSegment(params.primaryId))
        ),
    }),

    file("objects/:objectTypeId/:primaryId/links.json", {
      contentType: JSON_CONTENT_TYPE,
      read: async ({ params }) =>
        json(
          await api.listLinks(decodeSegment(params.objectTypeId), decodeSegment(params.primaryId))
        ),
    }),

    dir("objects/:objectTypeId/:primaryId/actions", {
      list: async ({ params }) => {
        const objectType = await api.getObjectType(decodeSegment(params.objectTypeId))
        return (objectType?.actions ?? []).map((objectAction) =>
          actionEntry(
            `objects/${params.objectTypeId}/${params.primaryId}/actions/${segment(
              objectAction.id
            )}`,
            objectAction.description
          )
        )
      },
    }),

    action("objects/:objectTypeId/:primaryId/actions/:actionId", {
      description: "Request a Pario action on an object.",
      list: async ({ path }) => [
        jsonFile(`${path}/action.json`),
        jsonFile(`${path}/input.schema.json`),
      ],
      read: async ({ params, path }) =>
        json(actionDescriptor(await resolveAction(api, params, path))),
      invoke: async ({ params }, input): Promise<S4InvokeResult> => {
        const result = await api.requestAction(
          decodeSegment(params.objectTypeId),
          decodeSegment(params.primaryId),
          decodeSegment(params.actionId),
          asJsonObject(input)
        )

        return { status: "accepted", value: result }
      },
    }),

    file("objects/:objectTypeId/:primaryId/actions/:actionId/action.json", {
      contentType: JSON_CONTENT_TYPE,
      read: async ({ params, path }) =>
        json(actionDescriptor(await resolveAction(api, params, path))),
    }),

    file("objects/:objectTypeId/:primaryId/actions/:actionId/input.schema.json", {
      contentType: JSON_CONTENT_TYPE,
      read: async ({ params, path }) => {
        const actionDef = await resolveAction(api, params, path)
        return json(actionParamsToJsonSchema(actionDef.params ?? []))
      },
    }),
  ]
}

async function resolveAction(
  api: ParioS4Api,
  params: Readonly<Record<string, string>>,
  path: string
): Promise<ActionDef> {
  const objectType = await api.getObjectType(decodeSegment(params.objectTypeId))
  const actionId = decodeSegment(params.actionId)
  const actionDef = objectType?.actions.find((candidate) => candidate.id === actionId)
  if (!actionDef) {
    throw new S4NotFoundError(path)
  }
  return actionDef
}

function actionDescriptor(actionDef: ActionDef) {
  return {
    id: actionDef.id,
    ...(actionDef.name ? { name: actionDef.name } : {}),
    ...(actionDef.description ? { description: actionDef.description } : {}),
    inputSchemaPath: "input.schema.json",
  }
}

function asJsonObject(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) {
    return {}
  }
  if (typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  throw new Error("[ParioS4] Action input must be a JSON object.")
}
