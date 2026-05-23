import type { OntologySource, Sixb } from "@sixb/core"
import type { Elysia } from "elysia"
import { ErrorResponseSchema } from "../schemas/common"
import { ObjectTypeParamsSchema, ObjectTypeSchema } from "../schemas/ontology"

function serializeObjectType(
  sixb: Sixb<readonly OntologySource[]>,
  objectType: ReturnType<Sixb<readonly OntologySource[]>["listObjectTypes"]>[number]
) {
  return {
    id: objectType.id,
    name: objectType.name,
    description: objectType.description,
    extends: objectType.extends,
    implements: objectType.implements,
    properties: objectType.properties,
    links: objectType.links.map((link) => ({
      id: link.id,
      name: link.name,
      description: link.description,
      targetObjectTypeId: link.targetObjectTypeId,
      cardinality: link.cardinality,
      properties: link.properties,
    })),
    actions: sixb.getActionsForType(objectType).map((action) => ({
      id: action.id,
      name: action.id,
      description: action.description,
      params: Object.entries(action.params).map(([id, config]) => ({
        id,
        name: id,
        schema: config.schema,
        required: config.required ?? false,
        description: config.description,
        semanticType: config.semanticType,
      })),
    })),
  }
}

export function registerOntologyRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/object-types",
      async () => {
        return sixb.listObjectTypes().map((objectType) => serializeObjectType(sixb, objectType))
      },
      {
        response: { 200: ObjectTypeSchema.array() },
        detail: {
          summary: "List registered object types",
          tags: ["Ontology"],
          operationId: "listObjectTypes",
        },
      }
    )
    .get(
      "/api/object-types/:objectTypeId",
      async ({ params, set }) => {
        const objectType = sixb.getObjectTypeById(params.objectTypeId)
        if (!objectType) {
          set.status = 404
          return { error: "Object type not found" }
        }

        return serializeObjectType(sixb, objectType)
      },
      {
        params: ObjectTypeParamsSchema,
        response: { 200: ObjectTypeSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get object type definition",
          tags: ["Ontology"],
          operationId: "getObjectType",
        },
      }
    )
}
