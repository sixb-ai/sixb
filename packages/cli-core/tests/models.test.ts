import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInstanceApiClient } from "../src"
import { describeCost, describePrice, findModel, models } from "../src/commands/models"
import type { CliError } from "../src/output"

let server: ReturnType<typeof Bun.serve> | undefined
/** What the stub API received, and the routes a test adds beside the catalog. */
let received: { method: string; path: string; body?: unknown; type?: string }[] = []
let routes: Record<string, (request: Request) => Response | Promise<Response>> = {}
const directories: string[] = []

afterEach(async () => {
  server?.stop(true)
  server = undefined
  received = []
  routes = {}
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true })
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
    fetch: async (request) => {
      const url = new URL(request.url)
      const key = `${request.method} ${url.pathname}`
      if (request.method === "POST" && url.pathname === "/api/files") {
        // The part's own header, not a type Bun would infer from the file name: a Node client
        // that labels nothing sends application/octet-stream, and the upload has no media type.
        const raw = await request.text()
        const type = /content-type: *([^\r\n]+)/i.exec(raw.split('name="file"')[1] ?? "")?.[1]
        received.push({ method: request.method, path: url.pathname, type })
        return Response.json({ blobId: "blob_upload", sizeBytes: 4, mediaType: type })
      }
      received.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        ...(request.method === "POST" ? { body: await request.json() } : {}),
      })
      const route = routes[key]
      if (route) return route(request)
      return Response.json(catalog)
    },
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

const PNG = new Uint8Array([137, 80, 78, 71])
const JPEG = new Uint8Array([255, 216, 255])
const AUDIO = new TextEncoder().encode("ID3")
const call = (extra: Record<string, unknown>) => ({
  callId: "call_1",
  model: { provider: "vercel-ai-gateway", modelId: "bfl/flux-3-image-klein" },
  cost: { status: "reported", money: { currency: "USD", amountNanos: "8000000" } },
  usage: {},
  warnings: [],
  ...extra,
})

/** Serve call_1's files: the file at /files/<index> is `bodies[index]`. */
function serveFiles(bodies: readonly Uint8Array<ArrayBuffer>[]) {
  routes["GET /api/ai/model-calls/call_1/files/content"] = (request) => {
    const index = Number(new URL(request.url).searchParams.get("path")?.split("/")[2])
    return new Response(bodies[index])
  }
}

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sixb-models-cli-"))
  directories.push(directory)
  return directory
}

describe("models generation", () => {
  test("image writes each file where --output says, with the extension its type has", async () => {
    const directory = await temporary()
    const reference = join(directory, "sketch.png")
    await Bun.write(reference, PNG)
    routes["POST /api/models/image/generations"] = () =>
      Response.json(call({ files: [{ mediaType: "image/png" }, { mediaType: "image/jpeg" }] }))
    serveFiles([PNG, JPEG])

    const output = join(directory, "out", "hero.png")
    const result = await run([
      "image",
      "a fox",
      "--output",
      output,
      "--model",
      "bfl/flux-3-image-klein",
      "--size",
      "768x768",
      "--n",
      "2",
      "--image",
      reference,
      "--image",
      reference,
    ])

    const hero = join(directory, "out", "hero")
    expect(result).toEqual({
      callId: "call_1",
      model: "bfl/flux-3-image-klein",
      files: [`${hero}-1.png`, `${hero}-2.jpg`],
      cost: "$0.008",
    })
    expect(new Uint8Array(await readFile(`${hero}-1.png`))).toEqual(PNG)
    expect(new Uint8Array(await readFile(`${hero}-2.jpg`))).toEqual(JPEG)
    // Removal proof: drop the media type from uploadInput's upload; the parts go unlabeled.
    // Both references were uploaded as images before the call, which names the resolved model.
    expect(received.filter((request) => request.path === "/api/files")).toEqual([
      { method: "POST", path: "/api/files", type: "image/png" },
      { method: "POST", path: "/api/files", type: "image/png" },
    ])
    expect(
      received.find((request) => request.path === "/api/models/image/generations")?.body
    ).toEqual({
      model: { provider: "vercel-ai-gateway", modelId: "bfl/flux-3-image-klein" },
      prompt: "a fox",
      n: 2,
      size: "768x768",
      images: [
        { blobId: "blob_upload", sizeBytes: 4, mediaType: "image/png" },
        { blobId: "blob_upload", sizeBytes: 4, mediaType: "image/png" },
      ],
    })
  })

  test("speech takes a format, and a directory output names the file by its call", async () => {
    const directory = await temporary()
    routes["POST /api/models/audio/speech"] = () =>
      Response.json(call({ files: [{ mediaType: "audio/wav" }], cost: { status: "unpriceable" } }))
    serveFiles([AUDIO])

    const result = await run(["speech", "Hello.", "--output", `${directory}/`, "--format", "wav"])

    expect(result).toEqual({
      callId: "call_1",
      model: "bfl/flux-3-image-klein",
      files: [join(directory, "call_1.wav")],
      cost: "unknown",
    })
    expect(received.find((request) => request.path === "/api/models/audio/speech")?.body).toEqual({
      text: "Hello.",
      mediaType: "audio/wav",
    })
  })

  test("text and transcribe answer with the text", async () => {
    const directory = await temporary()
    const audio = join(directory, "note.mp3")
    await Bun.write(audio, AUDIO)
    routes["POST /api/models/language/generations"] = () =>
      Response.json(call({ text: "Shipped.", finishReason: "stop" }))
    routes["POST /api/models/audio/transcriptions"] = () =>
      Response.json(call({ text: "Hello there." }))

    expect(await run(["text", "Status?", "--max-output-tokens", "20"])).toMatchObject({
      text: "Shipped.",
      finishReason: "stop",
      cost: "$0.008",
    })
    expect(
      received.find((request) => request.path === "/api/models/language/generations")?.body
    ).toEqual({ prompt: "Status?", maxOutputTokens: 20 })
    expect(await run(["transcribe", audio])).toMatchObject({ text: "Hello there." })
    expect(received.find((request) => request.path === "/api/files")?.type).toBe("audio/mpeg")
  })

  test("calls files shows a call's files, or downloads them again", async () => {
    const directory = await temporary()
    const files = [{ blobId: "blob_1", mediaType: "image/png", sizeBytes: 4 }]
    routes["GET /api/ai/model-calls/call_1/files"] = () =>
      Response.json({ callId: "call_1", files, recordedAt: "2026-10-22T12:00:00.000Z" })
    serveFiles([PNG])

    expect(await run(["calls", "files", "call_1"])).toMatchObject({ callId: "call_1", files })
    expect(await run(["calls", "files", "call_1", "--output", join(directory, "again")])).toEqual({
      callId: "call_1",
      files: [join(directory, "again.png")],
    })
  })

  test("refuses a request it can tell is wrong before calling", async () => {
    const directory = await temporary()
    const notes = join(directory, "notes.txt")
    await Bun.write(notes, "x")
    const failure = (args: readonly string[]) =>
      run(args).then(
        () => undefined,
        (error: CliError) => error.body.message
      )

    expect(await failure(["image", "a fox"])).toBe(
      "models image requires --output <path>: a file, or a directory ending in /."
    )
    expect(await failure(["image", "a fox", "--output", "x.png", "--image", notes])).toBe(
      `'${notes}' is not an image file. Use .png, .jpg, .jpeg, .webp, .gif.`
    )
    expect(await failure(["speech", "Hi.", "--output", "x.mp3", "--format", "midi"])).toBe(
      "--format must be mp3, wav, ogg, aac, or flac."
    )

    // The gateway makes Opus inside Ogg: `ogg` asks for it, and audio/opus is never served.
    expect(await failure(["speech", "Hi.", "--output", "x.ogg", "--format", "opus"])).toBe(
      "--format must be mp3, wav, ogg, aac, or flac."
    )
    expect(received.filter((request) => request.method === "POST")).toEqual([])
  })

  test("reads a cost in dollars without rounding", () => {
    expect(describeCost({ status: "rated", money: { amountNanos: "96000" } })).toBe("$0.000096")
    expect(describeCost({ status: "reported", money: { amountNanos: "1250000000" } })).toBe("$1.25")
    expect(describeCost({ status: "unpriceable" })).toBe("unknown")
  })
})
