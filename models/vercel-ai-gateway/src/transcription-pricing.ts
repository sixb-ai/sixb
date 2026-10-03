import type { ModelCostEstimate, TranscriptionCostEstimator } from "@sixb/core/models"

const UNITS_PER_MILLION = 1_000_000n

/** The catalog exposes a per-second tariff. Content duration produces an estimate, never a bill. */
export function transcriptionDurationEstimator(
  modelId: string,
  dollarsPerSecond: string | undefined
): TranscriptionCostEstimator {
  return {
    estimate({ usage, responseModelId, route }): ModelCostEstimate {
      if (
        !dollarsPerSecond ||
        (responseModelId && responseModelId !== modelId) ||
        (route?.modelId && route.modelId !== modelId)
      ) {
        return { status: "unpriceable", reason: "missing-rate-card" }
      }

      const durationMs = usage.audioDurationMs
      if (durationMs === undefined) {
        return {
          status: "unpriceable",
          reason: "missing-usage",
          missingMeters: ["audio.input.milliseconds"],
        }
      }
      if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
        return { status: "unpriceable", reason: "inconsistent-usage" }
      }

      const rateNanosPerMillionMs = durationRate(dollarsPerSecond)
      const chargeNanos =
        (BigInt(durationMs) * rateNanosPerMillionMs + UNITS_PER_MILLION / 2n) / UNITS_PER_MILLION

      return {
        status: "rated",
        money: { currency: "USD", amountNanos: chargeNanos.toString() },
        components: [
          {
            meter: "audio.input.milliseconds",
            quantity: String(durationMs),
            rateAmountNanosPerMillion: rateNanosPerMillionMs.toString(),
            chargeAmountNanos: chargeNanos.toString(),
          },
        ],
      }
    },
  }
}

/** $/second -> nanos per million milliseconds, rounded without floating-point money. */
function durationRate(dollarsPerSecond: string): bigint {
  const [whole = "0", fraction = ""] = dollarsPerSecond.split(".")
  const wholeNanos = BigInt(whole) * 1_000_000_000_000n
  const fractionalNanos = BigInt(fraction.slice(0, 12).padEnd(12, "0"))
  const rounding = Number(fraction[12] ?? "0") >= 5 ? 1n : 0n

  return wholeNanos + fractionalNanos + rounding
}
