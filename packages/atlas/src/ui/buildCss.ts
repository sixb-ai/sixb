import { ensureBuiltInUiCss } from "./css"

const css = await ensureBuiltInUiCss()
await css.stop()
