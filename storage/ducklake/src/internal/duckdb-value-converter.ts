import {
  DuckDBDecimalValue,
  DuckDBTypeId,
  type DuckDBValueConverter,
  type JS,
  JSDuckDBValueConverter,
} from "@duckdb/node-api"
import { LakeStorageError } from "@sixb/core/lake-storage"

/**
 * Preserve DuckDB decimals as exact strings while retaining the driver's normal
 * JavaScript conversions for every other scalar and nested value.
 */
export const sixbDuckDbValueConverter: DuckDBValueConverter<JS> = (value, type, converter) => {
  if (value === null) {
    return null
  }

  if (type.typeId === DuckDBTypeId.DECIMAL) {
    if (!(value instanceof DuckDBDecimalValue)) {
      throw new LakeStorageError("[SixbDuckLake] DuckDB returned an invalid DECIMAL value.")
    }
    return value.toString()
  }

  return JSDuckDBValueConverter(value, type, converter)
}
