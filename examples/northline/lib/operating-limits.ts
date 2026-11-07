/**
 * Where a unit's latest readings turn it from healthy to watch to unhealthy, in °C and amps. The
 * health pipeline classifies by them, verifying recovery checks against them, and the equipment
 * page draws its healthy bands from them.
 */
export const operatingLimits = {
  /** Supply air at or above this is trending high: the unit goes on watch. */
  supplyAirWatch: 19,
  /** Supply air at or above this means the unit is not cooling: unhealthy. */
  supplyAirUnhealthy: 22,
  /** Compressor current at or above this means the compressor is straining: unhealthy. */
  compressorUnhealthy: 28,
} as const
