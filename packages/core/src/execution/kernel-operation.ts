import type { KernelOperation } from "./types"

const KERNEL_OPERATION_TYPES: ReadonlySet<string> = new Set<KernelOperation["type"]>([
  "ontology.recover",
  "ontology.indexVectors",
  "artifacts.transcribeMedia",
  "ontology.loadSnapshot",
])

export function isKernelOperationType(type: unknown): type is KernelOperation["type"] {
  return typeof type === "string" && KERNEL_OPERATION_TYPES.has(type)
}

export function kernelOperationId(operation: KernelOperation): string {
  switch (operation.type) {
    case "ontology.recover":
      return operation.recoveryId
    case "ontology.indexVectors":
      return operation.indexingId
    case "artifacts.transcribeMedia":
      return operation.digest
    case "ontology.loadSnapshot":
      return operation.snapshotId
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
    case "artifacts.transcribeMedia":
      return { type, digest: id }
    case "ontology.loadSnapshot":
      return { type, snapshotId: id }
    default:
      return unknownOperation(type)
  }
}

function unknownOperation(_operation: never): never {
  throw new Error("[Sixb] Unknown kernel operation.")
}
