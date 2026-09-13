import type { ValueType } from "../../ontology"
import type {
  InferParams,
  ParamConfig,
  ParamPrimitiveSchemaValues,
  ParamsConfig,
} from "../../shared/params/types"

/** Action-facing name for one shared declarative parameter. */
export type ActionParamConfig = ParamConfig

/** Action-facing name for the shared parameter shape. */
export type ActionParamsConfig = ParamsConfig

/** Action-facing compatibility name for the shared typed primitive mapping. */
export type ActionPrimitiveSchemaValues = ParamPrimitiveSchemaValues

/** Action-facing compatibility name for the shared parameter inference contract. */
export type InferActionParams<
  TParams extends ActionParamsConfig,
  TValueTypes extends readonly ValueType[] = [],
> = InferParams<TParams, TValueTypes>
