import { startFrameEditor } from "./frame"
import { FRAME_EDITOR_GLOBAL } from "./protocol"

// The editor's script, as the frame's runtime runs it: it leaves its start where the runtime takes
// it at once, before anything else can.
;(globalThis as Record<string, unknown>)[FRAME_EDITOR_GLOBAL] = startFrameEditor
