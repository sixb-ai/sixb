import type { KernelOperation } from "./types"

export function kernelOperationId(operation: KernelOperation): string {
  switch (operation.type) {
    case "ontology.recover":
      return operation.recoveryId
    case "ontology.indexVectors":
      return operation.indexingId
    default:
      return unknownOperation(operation)
  }
}

export function kernelOperationFromId(type: KernelOperation["type"], id: string): KernelOperation {
  switch (type) {
    case "ontology.recover":
      return { type, recoveryId: id }
    case "ontology.indexVectors":
      return { type, indexingId: id }
    default:
      return unknownOperation(type)
  }
}

function unknownOperation(_operation: never): never {
  throw new Error("[Sixb] Unknown kernel operation.")
}
