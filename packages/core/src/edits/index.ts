export { EditBatchError } from "./errors"
export { normalizeEditBatch, normalizeEditOperationInput } from "./normalize"
export { recordEdits } from "./recorder"
export type {
  EditBatch,
  EditBatchInput,
  EditBatchProducer,
  EditBatchVersion,
  EditCommitDiff,
  EditCreateProperties,
  EditLinkCreateOperation,
  EditLinkDeleteOperation,
  EditLinkDiff,
  EditObjectCreateOperation,
  EditObjectDeleteOperation,
  EditObjectDiff,
  EditObjectHandle,
  EditObjectProperties,
  EditObjectRef,
  EditObjectSetRecorder,
  EditObjectUpdateOperation,
  EditOperation,
  EditUpdateProperties,
  NormalizedEditBatchResult,
  RecordEditsContext,
  RecordEditsHandler,
  RecordEditsOptions,
  TypedEditObjectRef,
} from "./types"
export type { ValidateEditBatchInput, ValidateEditBatchResult } from "./validation"
export { deriveEditCommitDiff, validateEditBatch } from "./validation"
