import { ThemeProvider } from "@sixb/ui/hooks"
import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App"

const root = document.getElementById("root")

if (!root) {
  throw new Error("[SixbDocs] Missing root element.")
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
)
