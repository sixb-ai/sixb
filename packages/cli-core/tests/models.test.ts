import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createInstanceApiClient } from "../src"
import { describePrice, findModel, models } from "../src/commands/models"
import type { CliError } from "../src/output"

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
})

const entry = (modelId: string, extra: Record<string, unknown> = {}) => ({
  provider: "vercel-ai-gateway",
  modelId,
  isDefault: false,
  name: modelId,
  ...extra,
})

const catalog = {
  language: [
    entry("anthropic/claude-sonnet-5-5", {
      isDefault: true,
      rateCard: { currency: "USD", input: "3", output: "15" },
    }),
    entry("google/gemini-3.1-flash-lite-image"),
  ],
  image: [
    entry("bfl/flux-3-image-klein", {
      isDefault: true,
      description: "Fast drafts and thumbnails",
      sizes: ["768x768", "1024x1024"],
      rateCard: {
        currency: "USD",
        images: {
          default: "0.009",
          variants: [
            { size: "768x768", price: "0.008" },
            { size: "1024x1024", price: "0.009" },
          ],
        },
      },
    }),
    entry("google/gemini-3.1-flash-lite-image", {
      rateCard: { currency: "USD", input: "0.25", output: "1.5", images: "0.034" },
    }),
    entry("example/unpriced"),
  ],
  audio: {
    speech: [entry("openai/tts-1", { rateCard: { currency: "USD", characters: "15" } })],
    transcription: [
      entry("openai/gpt-4o-transcribe", {
        rateCard: { currency: "USD", audioInputSeconds: "0.0001" },
      }),
    ],
  },
}

async function run(args: readonly string[]): Promise<unknown> {
  server ??= Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(catalog),
  })
  const api = createInstanceApiClient({
    kind: "local",
    baseUrl: `http://127.0.0.1:${server.port}`,
    token: "sixb_pat_test.secret",
    profile: "test",
  })
  const written: string[] = []
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk))
    return true
  })
  try {
    await models(api, args)
  } finally {
    write.mockRestore()
  }
  return JSON.parse(written.join(""))
}

describe("models", () => {
  test("list every kind, or one, with what each model costs", async () => {
    expect(await run(["list", "--kind", "image"])).toEqual([
      {
        kind: "image",
        model: "bfl/flux-3-image-klein",
        provider: "vercel-ai-gateway",
        default: true,
        description: "Fast drafts and thumbnails",
        price: "per image: $0.008 at 768x768, $0.009 at 1024x1024, otherwise $0.009",
      },
      {
        kind: "image",
        model: "google/gemini-3.1-flash-lite-image",
        provider: "vercel-ai-gateway",
        price: "$0.034 per image · $0.25 input · $1.5 output per 1M tokens",
      },
      {
        kind: "image",
        model: "example/unpriced",
        provider: "vercel-ai-gateway",
        price: "price unknown",
      },
    ])
    const all = (await run(["list"])) as { kind: string }[]
    expect(all.map((model) => model.kind)).toEqual([
      "language",
      "language",
      "image",
      "image",
      "image",
      "speech",
      "transcription",
    ])
  })

  test("get one model's options and rate card", async () => {
    expect(await run(["get", "bfl/flux-3-image-klein"])).toMatchObject({
      kind: "image",
      model: "bfl/flux-3-image-klein",
      default: true,
      sizes: ["768x768", "1024x1024"],
      rateCard: { currency: "USD" },
    })
    // Gemini image models are both language and image models; --kind picks one.
    expect(
      await run(["get", "google/gemini-3.1-flash-lite-image", "--kind", "image"])
    ).toMatchObject({ kind: "image", price: expect.stringContaining("$0.034 per image") })
  })

  test("say what a request must add when an id names several models", () => {
    const entries = [
      { kind: "language" as const, entry: entry("shared") },
      { kind: "image" as const, entry: entry("shared") },
      { kind: "image" as const, entry: { ...entry("twin"), provider: "a" } },
      { kind: "image" as const, entry: { ...entry("twin"), provider: "b" } },
    ]
    const failure = (reference: string, kind?: "image") => {
      try {
        findModel(entries, reference, kind)
      } catch (error) {
        return (error as CliError).body.message
      }
      return undefined
    }
    expect(failure("shared")).toBe(
      "'shared' is configured as language and image. Add --kind <kind>."
    )
    expect(failure("twin")).toBe("'twin' is configured by a and b. Use provider:twin.")
    expect(findModel(entries, "b:twin", undefined).entry.provider).toBe("b")
    // Removal proof: split the provider off before trying the whole reference; this id is lost.
    expect(
      findModel(
        [{ kind: "language", entry: entry("meta/llama-3:free") }],
        "meta/llama-3:free",
        undefined
      ).entry.modelId
    ).toBe("meta/llama-3:free")
    expect(failure("missing", "image")).toBe(
      "No image model 'missing' is configured. Run 'sixb models list'."
    )
  })

  test("read every kind of price", () => {
    expect(describePrice(undefined)).toBe("price unknown")
    expect(
      describePrice({ images: { default: "0.034", variants: [{ size: "1K", price: "0.034" }] } })
    ).toBe("$0.034 per image")
    expect(describePrice({ characters: "15" })).toBe("$15 per 1M characters")
    expect(describePrice({ audioInputSeconds: "0.0001" })).toBe("$0.0001 per second of audio")
    expect(
      describePrice({
        input: { default: "1", tiers: [{ price: "1" }, { price: "2.5" }] },
        output: "4",
      })
    ).toBe("$1 input · $4 output per 1M tokens")
    expect(describePrice({ input: "0.5", output: "6", audioOutput: "6" })).toBe(
      "$0.5 input · $6 output per 1M tokens · $6 per 1M audio tokens"
    )
  })

  test("reject an unknown kind before asking the API", async () => {
    const error = await run(["list", "--kind", "video"]).catch((caught: unknown) => caught)
    expect((error as CliError).body.message).toBe(
      "Unknown model kind 'video'. Use one of: language, image, speech, transcription."
    )
  })
})
