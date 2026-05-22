import React from "react"
import ReactDOM from "react-dom/client"

import "./preview.css"
import { PreviewApp } from "./PreviewApp"

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PreviewApp />
  </React.StrictMode>
)
