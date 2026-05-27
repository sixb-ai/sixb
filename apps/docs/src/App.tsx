import { docs } from "./generated/docs"

export function App() {
  const pathname = window.location.pathname.replace(/\/$/, "") || "/"
  const currentDoc = docs.find((doc) => doc.routePath === pathname)

  if (currentDoc) {
    return (
      <main className="doc-layout">
        <header className="doc-topbar">
          <a className="doc-home-link" href="/">
            Sixb Docs
          </a>
          <a className="doc-markdown-link" href={currentDoc.markdownPath}>
            Markdown
          </a>
        </header>
        <div className="doc-body">
          <aside className="doc-sidebar" aria-label="Documentation">
            <nav className="doc-sidebar-nav">
              {docs.map((doc) => (
                <a
                  key={doc.routePath}
                  className={
                    doc.routePath === currentDoc.routePath
                      ? "doc-sidebar-link active"
                      : "doc-sidebar-link"
                  }
                  href={doc.routePath}
                >
                  {doc.title}
                </a>
              ))}
            </nav>
          </aside>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Docs HTML is generated from trusted repository markdown. */}
          <article className="doc-content" dangerouslySetInnerHTML={{ __html: currentDoc.html }} />
        </div>
      </main>
    )
  }

  return (
    <main className="docs-shell" aria-labelledby="docs-title">
      <h1 id="docs-title" className="docs-title">
        Sixb Docs
      </h1>
      <nav className="docs-toc" aria-label="Documentation">
        {docs.map((doc) => (
          <a key={doc.routePath} className="docs-link" href={doc.routePath}>
            {doc.title}
          </a>
        ))}
      </nav>
    </main>
  )
}
