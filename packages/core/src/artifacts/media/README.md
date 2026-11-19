# What is derived of a media

A video or a sound of any artifact version gets a probe, a proxy, a poster, a filmstrip, its peaks,
its cuts and its transcript, once for every file that holds the same bytes. They are kept under the
digest of the original (`ArtifactStorage.listMedia` / `putMedia`), so no artifact owns them and
deleting one keeps them.

```text
publish (create, update, restore, the Agent's publish)
  → requestArtifactMedia: one artifact.media.requested job per digest with nothing kept,
    refreshArtifactMedia for one kept
render worker (packages/render-worker/src/media.ts)
  → putMedia: the attempt, counted before it starts
  → sandbox: fetch the original by download URL, derive.cjs probes it
  → putMedia: the probe, which gives the rest its time (mediaJobBudget)
  → derive.cjs derives each part with FFmpeg
  → putMedia: every part as it stands, the transcript pending
  → MediaTranscriber: the project's transcription model, as a kernel operation
  → putMedia: the transcript
readers
  → sixb.artifacts.media(): read through the artifact, as the caller reads it
  → GET …/versions/:v/media and …/media/content: each part's file, with Range
```

## Invariants

- One job id per digest (`mediaJobId`), enqueued with `replace`: asking while a job waits takes
  its place, asking while one runs waits behind it, and that one finds nothing left to derive.
- A job derives only the parts still `pending` in what is kept, so an attempt cut short between its
  writes transcribes without deriving the proxy again. It keeps only the parts it made, over what
  is kept by then: a part a retry made pending while it ran stays so for the job behind it.
- `attempts` counts the attempts since the media was last asked for, in what is kept, not in the
  job: a job asked for again keeps counting, and one asked for past `MEDIA_JOB.attempts` fails what
  is pending without deriving. Then what was derived stays.
- Each attempt has the time `mediaJobBudget` gives the probe: the proxy by the pixels it decodes,
  twice for HEVC, ProRes, AV1 or VP9, every other part by the media's length, at most
  `MEDIA_JOB.maxTimeoutMs`. Before the probe, the most.
- A job lost with its queue: nothing is written for longer than an attempt and its backoff take
  (`isMediaLost`), so the next publish or read asks for it again, its attempts kept.
- A part that fails is kept `failed` with a reason a reader can hear; FFmpeg's own words go to the
  logs. `unavailable` is no failure. Without `lacks`, the media is why: a sound has no poster, a
  sound browsers play needs no proxy, the media is longer than `MAX_MEDIA_DURATION_MS`, or its
  sound is longer than the model takes. With `lacks`, the project is why: no sandboxes, no FFmpeg
  or Node.js in them, no transcription model.
- `media({ retry: true })` (`retryArtifactMedia`) makes each failed part, and each the project
  lacked something for, pending again, counts the attempts from 0, and asks for the job. A
  transcript that lacked a model is asked for on its own at the next publish or read once the
  project has one; a sandbox's tools cannot be known without a sandbox, so they wait for a retry.

## Proxies in frames

Frames serve each file as its version holds it: a deck's or a page's clip plays its original,
whatever is derived of it. A video's frame plays proxies, through `mediaProxyReference` and
`requestedMediaProxy` (`media.ts`). The first names a ready proxy as the file's path with
`?sixb-proxy=<the proxy's digest>`: `rewriteVideoProxies` (`frames/assets.ts`) adds that query to
each recording a video's HTML file plays, its scenes' included. The second reads that name back on
the frame's request (`server/src/routes/artifact-frames.ts`). The original's address always serves
the original, so a page that loaded it keeps the bytes it loaded, and a page opened once the proxy
is ready plays the proxy. A name that is not the ready proxy's is a 404, never other bytes.

## Who pays for the transcript

Nobody asked for it but the project, and the same bytes are transcribed once for every artifact
that holds them, so it runs as the kernel operation `artifacts.transcribeMedia` (`transcriber.ts`):
one execution per digest, with no requester, on the project's model budget, recorded like any
model call. Its accounting reads `requesterGroupIds: []`, so no one person's limits apply.
