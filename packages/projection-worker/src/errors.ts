export class ProjectionWorkerError extends Error {
  override readonly name: string = "ProjectionWorkerError"
}

/** A deterministic input/configuration failure that cannot succeed on queue redelivery. */
export class ProjectionWorkerPermanentError extends ProjectionWorkerError {
  override readonly name = "ProjectionWorkerPermanentError"
}
