import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { ValueType } from "../ontology/types"
import type { ObjectSetListInput } from "../runtime/types"
import type { ActionReadFacade, ActionReadObjectSet } from "./types"

export type ActionReadObjectSetSource = {
  get(id: string): Promise<unknown>
  query(): unknown
  list(input?: ObjectSetListInput): Promise<unknown>
  byId(id: string): {
    get(): Promise<unknown>
    listLinks(link?: unknown): Promise<unknown>
  }
}

export function createActionReadFacade(
  createObjectSet: <const TObjectType extends ObjectTypeWithPropertyTokens>(
    objectType: TObjectType
  ) => ActionReadObjectSetSource
): ActionReadFacade {
  const facade = {
    objects<const TObjectType extends ObjectTypeWithPropertyTokens>(objectType: TObjectType) {
      return createActionReadObjectSetAdapter<TObjectType>(createObjectSet(objectType))
    },
  }

  return facade as ActionReadFacade
}

function createActionReadObjectSetAdapter<TObjectType extends ObjectTypeWithPropertyTokens>(
  objectSet: ActionReadObjectSetSource
): ActionReadObjectSet<TObjectType, readonly ValueType[], ObjectTypeWithPropertyTokens> {
  type TypedReadObjectSet = ActionReadObjectSet<
    TObjectType,
    readonly ValueType[],
    ObjectTypeWithPropertyTokens
  >

  return {
    get(id) {
      return objectSet.get(id) as ReturnType<TypedReadObjectSet["get"]>
    },
    query() {
      return objectSet.query() as ReturnType<TypedReadObjectSet["query"]>
    },
    list(input) {
      return objectSet.list(input) as ReturnType<TypedReadObjectSet["list"]>
    },
    byId(id) {
      const handle = objectSet.byId(id)
      return {
        get() {
          return handle.get() as ReturnType<ReturnType<TypedReadObjectSet["byId"]>["get"]>
        },
        listLinks(link) {
          return handle.listLinks(link) as ReturnType<
            ReturnType<TypedReadObjectSet["byId"]>["listLinks"]
          >
        },
      }
    },
  }
}
