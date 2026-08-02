import { defineConnector } from "@sixb/core"

const endpoint = "https://celestrak.org/NORAD/elements/gp.php?CATNR=66514&FORMAT=TLE"

function tleEpoch(line: string): Date {
  const year = Number(line.slice(18, 20))
  const day = Number(line.slice(20, 32))
  const fullYear = year < 57 ? 2000 + year : 1900 + year
  const days = fullYear % 4 === 0 && (fullYear % 100 !== 0 || fullYear % 400 === 0) ? 366 : 365
  if (!Number.isFinite(year) || !Number.isFinite(day) || day < 1 || day >= days + 1) {
    throw new Error("[Sentinel6B] CelesTrak returned an invalid TLE epoch.")
  }

  return new Date(Date.UTC(fullYear, 0, 1) + (day - 1) * 86_400_000)
}

export const celestrak = defineConnector("celestrak", {
  type: "celestrak",
  connect() {
    let cached:
      | { name: string; line1: string; line2: string; elementEpoch: Date; expiresAt: number }
      | undefined

    return {
      async latestOrbit(signal?: AbortSignal) {
        if (cached && cached.expiresAt > Date.now()) return cached

        const timeout = AbortSignal.timeout(10_000)
        const response = await fetch(endpoint, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        }).catch((error) => {
          throw new Error("[Sentinel6B] Could not reach CelesTrak.", { cause: error })
        })
        if (!response.ok) {
          throw new Error(`[Sentinel6B] CelesTrak returned HTTP ${response.status}.`)
        }

        const [name, line1, line2] = (await response.text()).trim().split(/\r?\n/)
        if (!name || !line1?.startsWith("1 66514") || !line2?.startsWith("2 66514")) {
          throw new Error("[Sentinel6B] CelesTrak returned an invalid TLE.")
        }

        cached = {
          name: name.trim(),
          line1,
          line2,
          elementEpoch: tleEpoch(line1),
          expiresAt: Date.now() + 2 * 60 * 60 * 1_000,
        }
        return cached
      },
    }
  },
})
