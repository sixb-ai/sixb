import { describe, expect, test } from "bun:test"
import {
  type ArtifactFile,
  artifactRef,
  defineAction,
  defineObjectType,
  type FileRef,
  param,
  prop,
  ref,
  SixbHost,
} from "../src"
import type { VideoOutline } from "../src/artifacts/outline"
import { videoExportPlan } from "../src/artifacts/video/export"
import type { AuthorizationContext } from "../src/authorization"
import { emptyGrantIndex } from "../src/authorization/types"
import { inferFileMediaType } from "../src/blob-storage/internal"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// An Action's handlers reach artifacts as whoever requested the run: an Action that uses an edit's
// MP4 as a post's media takes the export a person made, without the person downloading it and
// uploading it again.

const PROJECT = "action-artifacts"

const Post = defineObjectType({
  id: "Post",
  name: "Post",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("media", ref.file(), { nullable: true }),
  ],
})

const useEditAsMedia = defineAction("useEditAsMedia")
  .on(Post)
  .params({ edit: param(ref.artifact()) })
  .writeback(async ({ sixb, params }) => {
    const mp4 = await sixb.artifacts.video(params.edit.id, { render: false })
    if (mp4?.status !== "ready") throw new Error("Export the edit first.")

    return { media: mp4.file }
  })
  .edits(({ objects, subject, writeback }) => {
    objects(Post).byId(subject.primaryId).update({ media: writeback.media })
  })

const readTitle = defineAction("readTitle")
  .params({ artifactId: param("string") })
  .writeback(async ({ sixb, params }) => {
    const artifact = await sixb.artifacts.get(params.artifactId)
    return { title: artifact?.title ?? null }
  })

const scene = `<template>\n  <div data-composition-id="intro" data-width="1920" data-height="1080"><h1>Hi</h1></div>\n</template>\n`
const index = `<!doctype html>\n<html><body>\n<div data-composition-id="main" data-width="1920" data-height="1080" data-duration="2">\n<div id="intro" data-composition-id="intro" data-composition-src="scenes/intro.html" data-start="0" data-duration="2"></div>\n</div>\n</body></html>\n`

function member(id: string): AuthorizationContext {
  return {
    principal: { type: "user", id },
    groupIds: [],
    roleIds: [],
    grants: {
      ...emptyGrantIndex(),
      "view:object": new Set([Post.id]),
      "edit:object": new Set([Post.id]),
      "apply:action": new Set([useEditAsMedia.id, readTitle.id]),
    },
  }
}

async function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: PROJECT,
    ontology: [Post],
    actions: [useEditAsMedia, readTitle],
    ...deps,
  })
  for (const id of ["usr_alice", "usr_bob"]) {
    await deps.storage.auth.users.create({ projectId: PROJECT, id, email: `${id}@example.com` })
  }

  const system = createTestSixb(host)
  const as = (id: string) => createTestSixb(host, { authorization: member(id) })

  const put = async (path: string, body: string): Promise<ArtifactFile> => {
    const fileName = path.split("/").at(-1) ?? path
    const bytes = new TextEncoder().encode(body)
    const file = await deps.blobStorage.put({
      body: bytes,
      fileName,
      mediaType: inferFileMediaType(fileName, bytes),
    })
    return { path, file }
  }

  /** A video `owner` edits, rendered to an MP4 as they read it. */
  const renderedEdit = async (owner: string): Promise<{ id: string; mp4: FileRef }> => {
    const files = [await put("index.html", index), await put("scenes/intro.html", scene)]
    const { version } = await as(owner).artifacts.create({ kind: "video", title: "Teaser", files })
    const plan = videoExportPlan({
      outline: version.outline as VideoOutline,
      files: version.files,
      references: version.references,
      media: [],
    })

    const { file: mp4 } = await put("teaser.mp4", "mp4")
    await deps.storage.artifacts?.putVideoRender({
      projectId: PROJECT,
      key: plan.key,
      file: mp4,
      createdAt: new Date("2026-11-21T09:00:00.000Z"),
    })
    return { id: version.artifactId, mp4 }
  }

  return { system, as, put, renderedEdit }
}

describe("sixb.artifacts in an Action", () => {
  // Reproduce by leaving `artifacts` out of `toActionRuntimeFacade` (actions/run/context.ts): the
  // writeback finds none, and the run fails.
  test("hands an edit's MP4 to the writeback, which gives it to the post", async () => {
    const { system, as, renderedEdit } = await setup()
    const edit = await renderedEdit("usr_alice")
    await system.objects(Post).upsert({ properties: { id: "post-1" } })

    const run = await as("usr_alice")
      .objects(Post)
      .byId("post-1")
      .requestAction({ action: useEditAsMedia, params: { edit: artifactRef(edit.id) } })

    expect(run.status).toBe("succeeded")
    const post = await system.objects(Post).get("post-1")
    expect(post?.properties.media).toEqual({ ...edit.mp4, fileName: "Teaser.mp4" })
  })

  // Reproduce by giving the run its own trusted artifacts, `execution.sixb.artifacts`, in
  // `buildActionContext` (actions/run/execute.ts): Bob then reads Alice's draft.
  test("reads as the requester, not as the trusted run", async () => {
    const { system, as, put } = await setup()
    const draft = await as("usr_alice").artifacts.create({
      kind: "document",
      title: "Draft",
      files: [await put("document.md", "# Draft")],
    })
    const titleAs = async (sixb: ReturnType<typeof as>) => {
      const run = await sixb.actions.request({
        actionId: readTitle.id,
        params: { artifactId: draft.artifact.id },
      })
      return run.writeback?.result
    }

    expect(await titleAs(as("usr_alice"))).toEqual({ title: "Draft" })
    expect(await titleAs(as("usr_bob"))).toEqual({ title: null })
    // Requested by trusted code, as a schedule or a workflow requests it.
    expect(await titleAs(system)).toEqual({ title: "Draft" })
  })
})
