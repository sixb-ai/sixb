# What is derived of a media

A video or a sound of any artifact version gets a probe, a proxy, a poster, a filmstrip, its peaks,
its cuts and its transcript, once for every file that holds the same bytes. They are kept under the
digest of the original (`ArtifactStorage.listMedia` / `putMedia`), so no artifact owns them and
deleting one keeps them.

```text
publish (create, update, restore, the Agent's publish)
  → requestArtifactMedia: one artifact.media.requested job per digest with nothing kept
render worker (packages/render-worker/src/media.ts)
  → sandbox: fetch the original by download URL, media.cjs derives each part with FFmpeg
  → putMedia: every part as it stands, the transcript pending
  → MediaTranscriber: the project's transcription model, as a kernel operation
  → putMedia: the transcript
readers
  → sixb.artifacts.media(): read through the artifact, as the caller reads it
  → GET …/versions/:v/media and …/media/content: each part's file, with Range
  → frames serve a media's proxy in place of the original once it is ready
```

## Invariants

- One job id per digest (`mediaJobId`), enqueued with `replace`: asking while a job waits takes
  its place, asking while one runs waits behind it, and that one finds nothing left to derive. A job
  lost with its queue is asked for again by the next publish or read, since nothing is kept until
  a job keeps it.
- A job derives only the parts still `pending` in what is kept, so an attempt cut short between its
  two writes transcribes without deriving the proxy again. It keeps only the parts it made, over
  what is kept by then: a part a retry made pending while it ran stays so for the job behind it.
- A part that fails is kept `failed` with a reason a reader can hear; FFmpeg's own words go to the
  logs. `unavailable` is no failure: a sound has no poster, a project has no transcription model,
  a sandbox has no FFmpeg, or the media is longer than `MAX_MEDIA_DURATION_MS`.
- When the job gives up (`MEDIA_JOB.attempts`), what is still pending is kept as failed, and what
  was derived stays. `media({ retry: true })` (`retryArtifactMedia`) makes each failed part pending
  again and asks for the job, which then derives those alone.

## Who pays for the transcript

Nobody asked for it but the project, and the same bytes are transcribed once for every artifact
that holds them, so it runs as the kernel operation `artifacts.transcribeMedia` (`transcriber.ts`):
one execution per digest, with no requester, on the project's model budget, recorded like any
model call. Its accounting reads `requesterGroupIds: []`, so no one person's limits apply.
