import type { OntologySource, Sixb } from "@sixb/core"
import type { ExecutionSixb } from "@sixb/core/internal/request-execution"
import type { Elysia } from "elysia"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSdk } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import { ObjectTypeParamsSchema, ObjectTypeSchema } from "../schemas/ontology"

function serializeProperty(
  property: ReturnType<
    Sixb<readonly OntologySource[]>["objects"]["listTypes"]
  >[number]["properties"][number]
) {
  return {
    id: property.id,
    name: property.name,
    description: property.description,
    mode: property.mode,
    required: property.required,
    nullable: property.nullable,
    primary: property.primary,
    semanticType: property.semanticType,
    schema: property.schema,
    query: property.query ? { ...property.query } : undefined,
  }
}

function serializeSearch(
  search: ReturnType<Sixb<readonly OntologySource[]>["objects"]["listTypes"]>[number]["search"]
) {
  if (!search) return undefined
  return {
    title: search.title,
    defaultText: search.defaultText ? [...search.defaultText] : undefined,
    exact: search.exact ? [...search.exact] : undefined,
    vector: search.vector
      ? {
          property: search.vector.property,
          source: [...search.vector.source],
        }
      : undefined,
  }
}

function serializeObjectType(
  sdk: ExecutionSixb<readonly OntologySource[]>,
  objectType: ReturnType<Sixb<readonly OntologySource[]>["objects"]["listTypes"]>[number]
) {
  return {
    id: objectType.id,
    name: objectType.name,
    description: objectType.description,
    extends: objectType.extends,
    implements: objectType.implements ? [...objectType.implements] : undefined,
    properties: objectType.properties.map(serializeProperty),
    search: serializeSearch(objectType.search),
    links: objectType.links.map((link) => ({
      id: link.id,
      name: link.name,
      description: link.description,
      targetObjectTypeId: Array.isArray(link.targetObjectTypeId)
        ? [...link.targetObjectTypeId]
        : link.targetObjectTypeId,
      cardinality: link.cardinality,
      properties: link.properties?.map(serializeProperty),
    })),
    actions: sdk.actions.listForType(objectType).map((action) => ({
      id: action.id,
      name: action.id,
      description: action.description,
      params: Object.entries(action.params).map(([id, config]) => ({
        id,
        name: id,
        schema: config.schema,
        required: config.required ?? false,
        nullable: config.nullable,
        description: config.description,
        semanticType: config.semanticType,
      })),
    })),
  }
}

export function registerOntologyRoutes(app: Elysia, _sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/object-types",
      async (context) => {
        const sdk = requireRequestSdk(context)
        return sdk.objects.listTypes().map((objectType) => serializeObjectType(sdk, objectType))
      },
      {
        response: { 200: ObjectTypeSchema.array() },
        detail: {
          summary: "List registered object types",
          tags: [OPENAPI_TAGS.ontology.name],
          operationId: "listObjectTypes",
          security: bearerSecurityRequirement("listObjectTypes"),
        },
      }
    )
    .get(
      "/api/object-types/:objectTypeId",
      async (context) => {
        const { params, set } = context
        const sdk = requireRequestSdk(context)
        const objectType = sdk.objects.getTypeById(params.objectTypeId)
        if (!objectType) {
          set.status = 404
          return { error: "Object type not found" }
        }

        return serializeObjectType(sdk, objectType)
      },
      {
        params: ObjectTypeParamsSchema,
        response: { 200: ObjectTypeSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get object type definition",
          tags: [OPENAPI_TAGS.ontology.name],
          operationId: "getObjectType",
          security: bearerSecurityRequirement("getObjectType"),
        },
      }
    )
}
