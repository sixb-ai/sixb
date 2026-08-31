import { storageBoundaryError } from "../errors"

/** Converts raw connector-storage failures before they can cross a Core boundary. */
export async function withConnectorStorageBoundary<T>(
  message: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw storageBoundaryError(error, message)
  }
}
