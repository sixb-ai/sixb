"use client"

import { ArrowUpRight, Cable, Search } from "lucide-react"
import Image from "next/image"
import { useId, useState } from "react"
import { connectorCatalog } from "../docs/connectorCatalog"

export function ConnectorLibrary() {
  const searchId = useId()
  const [search, setSearch] = useState("")
  const [category, setCategory] = useState("All")
  const categories = ["All", ...new Set(connectorCatalog.map((entry) => entry.category))]
  const terms = search.toLowerCase().trim().split(/\s+/)
  const visible = connectorCatalog.filter(
    (entry) =>
      (category === "All" || category === entry.category) &&
      terms.every((term) =>
        `${entry.name} ${entry.description} @sixb/connector-${entry.package}`
          .toLowerCase()
          .includes(term)
      )
  )

  return (
    <section className="connector-library" aria-label="Connector library">
      <label className="connector-search" htmlFor={searchId}>
        <Search size={18} aria-hidden="true" />
        <input
          id={searchId}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search connectors"
          placeholder="Search platforms, protocols, or use cases…"
        />
      </label>
      <div className="connector-filters" aria-label="Connector categories">
        {categories.map((name) => (
          <button
            type="button"
            key={name}
            aria-pressed={category === name}
            onClick={() => setCategory(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <p className="connector-count" role="status">
        {visible.length} connector{visible.length === 1 ? "" : "s"}
      </p>
      <div
        key={`${category}-${search}`}
        className="connector-results"
        role="region"
        aria-label="Connector results"
        tabIndex={0}
      >
        <div className="connector-grid">
          {visible.map((entry) => (
            <a
              className="connector-card"
              key={entry.id}
              href={`https://github.com/sixb-ai/sixb/tree/main/connectors/${entry.package}#readme`}
              target="_blank"
              rel="noreferrer"
            >
              <div className="connector-card-top">
                <span className="connector-logo" aria-hidden="true">
                  {entry.icon ? (
                    <Image
                      unoptimized
                      src={`/assets/connectors/${entry.icon}`}
                      alt=""
                      width={26}
                      height={26}
                    />
                  ) : entry.category === "Protocols" ? (
                    <Cable size={24} />
                  ) : (
                    entry.name.slice(0, 2)
                  )}
                </span>
                <ArrowUpRight size={15} aria-hidden="true" />
              </div>
              <strong>{entry.name}</strong>
              <p>{entry.description}</p>
              <code>@sixb/connector-{entry.package}</code>
            </a>
          ))}
        </div>
        {visible.length === 0 && (
          <div className="connector-empty">
            <p>No connectors match these filters.</p>
            <button
              type="button"
              onClick={() => {
                setSearch("")
                setCategory("All")
              }}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
