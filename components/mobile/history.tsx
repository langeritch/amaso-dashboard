"use client"
import { useEffect, useState } from "react"
import { IconArrowLeft } from "./icons"
import AssistantMarkdown from "../AssistantMarkdown"

/**
 * Layer 5 — mobile history browser. Two sub-tabs (By topic / By day)
 * over a shared detail viewer. Reaches the same /api/spar/topics,
 * /api/spar/topics/[slug]/messages, /api/spar/days endpoints the
 * desktop history panel uses.
 */

interface TopicSummary {
  id: number
  slug: string
  title: string
  summary: string | null
  status: "active" | "archived"
  messageCount: number
  lastActiveAt: number
}

interface DaySummary {
  date: string
  activeConversationId: number | null
  conversationIds: number[]
  messageCount: number
  summary: string | null
  topics: { id: number; slug: string; title: string }[]
}

interface HistoryMessage {
  id: number
  role: "user" | "assistant" | "system"
  content: string
  createdAt: number
}

type Detail =
  | { kind: "topic"; slug: string; title: string }
  | { kind: "day"; date: string; conversationId: number }

export default function HistoryScreen({ onBack, onNavigateToChat }: { onBack: () => void; onNavigateToChat?: (prefill?: string) => void }) {
  const [tab, setTab] = useState<"topic" | "day">("topic")
  const [detail, setDetail] = useState<Detail | null>(null)
  // Layer 5: full-text search across messages + extracted facts. The
  // search bar at the top of the history view promotes to a fullscreen
  // results panel as soon as the query is non-empty; collapses back to
  // the tab list when cleared.
  const [search, setSearch] = useState("")
  const searchActive = search.trim().length >= 2

  if (detail?.kind === "topic") {
    return (
      <TopicDetail
        slug={detail.slug}
        fallbackTitle={detail.title}
        onBack={() => setDetail(null)}
        onAskAboutThis={(text) => {
          window.dispatchEvent(new CustomEvent("spar:prefill", { detail: { text } }))
          if (onNavigateToChat) onNavigateToChat(text)
          onBack()
        }}
      />
    )
  }
  if (detail?.kind === "day") {
    return (
      <DayDetail
        date={detail.date}
        conversationId={detail.conversationId}
        onBack={() => setDetail(null)}
      />
    )
  }

  return (
    <div className="amaso-screen" style={{ background: "var(--bg-0)" }}>
      <Header title="History" onBack={onBack} />
      <SearchBar value={search} onChange={setSearch} />
      {searchActive ? (
        <SearchResults
          query={search.trim()}
          onOpenConversation={(date, conversationId) =>
            setDetail({ kind: "day", date, conversationId })
          }
        />
      ) : (
        <>
          <div style={{ display: "flex", borderBottom: "1px solid var(--rule)" }}>
            {(["topic", "day"] as const).map((id) => {
              const active = tab === id
              return (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  style={{
                    flex: 1, padding: "12px 8px", border: "none",
                    background: active ? "var(--bg-2)" : "transparent",
                    color: active ? "var(--fg)" : "var(--fg-4)",
                    fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase",
                    cursor: "pointer", position: "relative",
                  }}
                >
                  {id === "topic" ? "By topic" : "By day"}
                  {active && (
                    <span aria-hidden style={{
                      position: "absolute", left: 12, right: 12, bottom: 0,
                      height: 2, background: "#f97316", borderRadius: 2,
                    }} />
                  )}
                </button>
              )
            })}
          </div>
          <div className="amaso-scroll" style={{ flex: 1, paddingTop: 8 }}>
            {tab === "topic" ? (
              <TopicList
                onOpen={(t) => setDetail({ kind: "topic", slug: t.slug, title: t.title })}
              />
            ) : (
              <DayList
                onOpen={(d) =>
                  d.activeConversationId !== null &&
                  setDetail({ kind: "day", date: d.date, conversationId: d.activeConversationId })
                }
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Layer 5: search bar ───────────────────────────────────────────────────

function SearchBar({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div style={{
      padding: "8px 12px",
      background: "var(--bg-0)",
      borderBottom: "1px solid var(--rule)",
      position: "sticky", top: 0, zIndex: 5,
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "6px 10px",
        background: "var(--bg-2)", border: "1px solid var(--rule)",
        borderRadius: 8,
      }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ color: "var(--fg-4)", flexShrink: 0 }}>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4-4" />
        </svg>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search messages and extracted facts…"
          style={{
            flex: 1, fontSize: 13, color: "var(--fg)",
            background: "transparent", border: "none", outline: "none",
          }}
        />
        {value && (
          <button
            onClick={() => onChange("")}
            aria-label="Clear search"
            style={{
              width: 18, height: 18, padding: 0,
              background: "transparent", border: "none", cursor: "pointer",
              color: "var(--fg-4)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M6 6l12 12" />
              <path d="M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

interface SearchBucket {
  date: string
  messages: Array<{ id: number; conversationId: number; role: string; createdAt: number; date: string; snippet: string }>
  facts: Array<{ id: number; date: string; classification: string; brainFile: string; section: string; snippet: string }>
}

function SearchResults({
  query,
  onOpenConversation,
}: {
  query: string
  onOpenConversation: (date: string, conversationId: number) => void
}) {
  const [data, setData] = useState<{ buckets: SearchBucket[]; totalMessages: number; totalFacts: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
    const t = setTimeout(() => {
      fetch(`/api/spar/history/search?q=${encodeURIComponent(query)}&limit=80`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d) => { if (!cancelled) setData({
          buckets: Array.isArray(d.buckets) ? d.buckets : [],
          totalMessages: d.totalMessages ?? 0,
          totalFacts: d.totalFacts ?? 0,
        }) })
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    }, 280)
    return () => { cancelled = true; clearTimeout(t) }
  }, [query])

  if (error) return <Empty msg={`Couldn't search (${error}).`} />
  if (data === null) return <Empty msg="Searching…" />
  if (data.buckets.length === 0) return <Empty msg={`No matches for "${query}".`} />

  return (
    <div className="amaso-scroll" style={{ flex: 1 }}>
      <div className="t-mono" style={{
        padding: "6px 14px", fontSize: 9, color: "var(--fg-4)",
        textTransform: "uppercase", letterSpacing: "0.18em",
        borderBottom: "1px solid var(--rule)",
      }}>
        {data.totalMessages} {data.totalMessages === 1 ? "message" : "messages"} · {data.totalFacts} {data.totalFacts === 1 ? "fact" : "facts"} · {data.buckets.length} {data.buckets.length === 1 ? "day" : "days"}
      </div>
      <div style={{ padding: "8px 12px 32px" }}>
        {data.buckets.map((b) => {
          // Pick a conversation id for the day. Search hits already
          // know which conversation each message came from; for a
          // facts-only bucket we leave the click as a no-op (the
          // facts are linked to brain files anyway).
          const targetConvId = b.messages[0]?.conversationId ?? null
          return (
          <div key={b.date} style={{ marginBottom: 18 }}>
            <button
              onClick={() => {
                if (targetConvId !== null) onOpenConversation(b.date, targetConvId)
              }}
              disabled={targetConvId === null}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "8px 10px", marginBottom: 6,
                background: "var(--bg-2)", border: "1px solid var(--rule)",
                borderRadius: 8,
                cursor: targetConvId === null ? "default" : "pointer",
                opacity: targetConvId === null ? 0.8 : 1,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--fg)" }}>{dayLabel(b.date)}</div>
              <div className="t-mono" style={{ fontSize: 9, color: "var(--fg-4)" }}>{b.date}</div>
            </button>
            {b.facts.map((f) => (
              <div key={`f-${f.id}`} style={{
                padding: "6px 10px", marginBottom: 4,
                background: "var(--bg-1)", borderLeft: "2px solid var(--accent)",
                borderRadius: "0 6px 6px 0",
                fontSize: 12, lineHeight: 1.45, color: "var(--fg-2)",
              }}>
                <ClassificationPill label={f.classification} />
                <span dangerouslySetInnerHTML={{ __html: f.snippet }} />
              </div>
            ))}
            {b.messages.map((m) => (
              <div key={`m-${m.id}`} style={{
                padding: "6px 10px", marginBottom: 4,
                background: "var(--bg-1)",
                borderRadius: 6,
                fontSize: 12, lineHeight: 1.45,
                color: m.role === "assistant" ? "var(--fg-2)" : "var(--fg-3)",
              }}>
                <span className="t-mono" style={{
                  fontSize: 9, color: m.role === "assistant" ? "var(--accent)" : "var(--fg-4)",
                  textTransform: "uppercase", letterSpacing: "0.12em", marginRight: 6,
                }}>{m.role}</span>
                <span dangerouslySetInnerHTML={{ __html: m.snippet }} />
              </div>
            ))}
          </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Layer 5: facts panel for DayDetail ────────────────────────────────────

interface ExtractedFactView {
  id: number
  fact: string
  classification: string
  brainFile: string
  section: string
  sourceMessageIds: number[]
}

interface ExtractionView {
  id: number
  status: string
  factCount: number
  classifications: Record<string, number>
  runAt: number
  errorText: string | null
}

/**
 * Classification → accent colour. The 11 classes follow a 4-bucket
 * palette (self / interpersonal / work / time) so a quick visual
 * scan groups facts by domain without forcing the reader to memorise
 * 11 distinct hues.
 */
function classificationStyle(cls: string): { bg: string; fg: string } {
  switch (cls) {
    case "identity":
    case "psychology":
    case "preferences":
      return { bg: "rgba(249,115,22,0.15)", fg: "#f97316" } // self → orange
    case "people":
      return { bg: "rgba(56,189,248,0.15)", fg: "#38bdf8" } // people → cyan
    case "projects":
    case "decisions":
    case "lessons":
    case "goals":
      return { bg: "rgba(110,231,168,0.15)", fg: "#6ee7a8" } // work → green
    case "calendar":
    case "timeline":
    case "daily-log-summary":
      return { bg: "rgba(252,211,77,0.15)", fg: "#fcd34d" } // time → amber
    default:
      return { bg: "var(--bg-3)", fg: "var(--fg-3)" }
  }
}

function ClassificationPill({ label }: { label: string }) {
  const { bg, fg } = classificationStyle(label)
  return (
    <span
      className="t-mono"
      style={{
        display: "inline-block",
        fontSize: 9, padding: "1px 6px", borderRadius: 999,
        background: bg, color: fg,
        textTransform: "lowercase", letterSpacing: 0.4,
        marginRight: 6,
        verticalAlign: "1px",
      }}
    >
      {label}
    </span>
  )
}

function FactsPanel({ date }: { date: string }) {
  const [data, setData] = useState<{
    extraction: ExtractionView | null
    facts: ExtractedFactView[]
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)

  const load = () => {
    setData(null)
    setError(null)
    fetch(`/api/spar/history/facts?date=${encodeURIComponent(date)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => setData({ extraction: d.extraction ?? null, facts: Array.isArray(d.facts) ? d.facts : [] }))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(() => { load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [date])

  const runExtraction = async () => {
    setRunning(true)
    setRunError(null)
    try {
      const r = await fetch("/api/admin/extract-facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, force: true }),
      })
      if (!r.ok) {
        const txt = await r.text().catch(() => "")
        throw new Error(`${r.status}${txt ? ": " + txt.slice(0, 120) : ""}`)
      }
      load()
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  if (error) {
    return (
      <div style={{
        margin: "10px 12px", padding: "10px 12px",
        background: "var(--bg-2)", border: "1px solid var(--rule)",
        borderRadius: 10, fontSize: 12, color: "var(--fg-4)",
      }}>
        Facts unavailable ({error}).
      </div>
    )
  }
  if (data === null) {
    return (
      <div style={{
        margin: "10px 12px", padding: "10px 12px",
        background: "var(--bg-2)", border: "1px solid var(--rule)",
        borderRadius: 10, fontSize: 12, color: "var(--fg-4)",
      }}>Loading facts…</div>
    )
  }

  const hasFacts = data.facts.length > 0
  const hasExtraction = data.extraction !== null

  return (
    <div style={{
      margin: "10px 12px", padding: "12px",
      background: "var(--bg-2)", border: "1px solid var(--rule)",
      borderRadius: 10,
    }}>
      <button
        onClick={() => setCollapsed((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          padding: 0, background: "transparent", border: "none",
          cursor: "pointer", textAlign: "left",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg)", flex: 1 }}>
          Facts extracted from this day
        </span>
        <span className="t-mono" style={{
          fontSize: 9, padding: "2px 6px", borderRadius: 999,
          background: "var(--bg-3)", color: "var(--fg-3)",
        }}>{data.facts.length}</span>
        <span style={{
          display: "inline-block", color: "var(--fg-4)",
          transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
          transition: "transform 0.15s ease",
        }}>▾</span>
      </button>
      {!collapsed && (
        <div style={{ marginTop: 10 }}>
          {!hasExtraction && (
            <div style={{ fontSize: 12, color: "var(--fg-4)", marginBottom: 8 }}>
              Not extracted yet for this day.
              <button
                onClick={runExtraction}
                disabled={running}
                style={{
                  marginLeft: 8, padding: "4px 10px", borderRadius: 6,
                  background: "var(--accent)", color: "var(--accent-fg)",
                  border: "none", fontFamily: "var(--font-mono)", fontSize: 11,
                  fontWeight: 600, cursor: running ? "default" : "pointer",
                  opacity: running ? 0.7 : 1,
                }}
              >
                {running ? "Running…" : "Run extraction"}
              </button>
              {runError && (
                <div style={{ marginTop: 6, fontSize: 11, color: "var(--bad)" }}>{runError}</div>
              )}
            </div>
          )}
          {hasExtraction && !hasFacts && (
            <div style={{ fontSize: 12, color: "var(--fg-4)", marginBottom: 8 }}>
              Extraction ran ({data.extraction!.status}) but produced no durable facts for this day.
              {data.extraction!.errorText && (
                <div style={{ marginTop: 4, color: "var(--bad)" }}>{data.extraction!.errorText}</div>
              )}
            </div>
          )}
          {hasFacts && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {data.facts.map((f) => (
                <a
                  key={f.id}
                  href={`/brain?file=${encodeURIComponent(f.brainFile)}&section=${encodeURIComponent(f.section)}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "block", padding: "8px 10px",
                    background: "var(--bg-1)", border: "1px solid var(--rule)",
                    borderRadius: 8, textDecoration: "none", color: "var(--fg-2)",
                    fontSize: 12, lineHeight: 1.5,
                  }}
                >
                  <div style={{ marginBottom: 4 }}>
                    <ClassificationPill label={f.classification} />
                    <span className="t-mono" style={{
                      fontSize: 9, color: "var(--fg-4)",
                      textTransform: "uppercase", letterSpacing: "0.12em",
                    }}>
                      {f.brainFile} · {f.section}
                    </span>
                  </div>
                  <div>{f.fact}</div>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div style={{
      padding: "env(safe-area-inset-top, 0px) 12px 12px",
      borderBottom: "1px solid var(--rule)",
      display: "flex", alignItems: "center", gap: 8,
      background: "var(--bg-0)",
    }}>
      <button
        onClick={onBack}
        className="btn-icon"
        title="Back"
        style={{ width: 36, height: 36 }}
      >
        <IconArrowLeft size={16} stroke={1.7} />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>{title}</div>
      </div>
    </div>
  )
}

function TopicList({ onOpen }: { onOpen: (t: TopicSummary) => void }) {
  const [items, setItems] = useState<TopicSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch("/api/spar/topics?limit=50")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { topics: TopicSummary[] }) => { if (!cancelled) setItems(d.topics ?? []) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [])
  if (error) return <Empty msg={`Couldn't load topics (${error}).`} />
  if (items === null) return <Empty msg="Loading…" />
  if (items.length === 0) return <Empty msg="No topics yet. They appear as you chat." />
  return (
    <div style={{ padding: "0 12px 24px" }}>
      {items.map((t) => (
        <button
          key={t.id}
          onClick={() => onOpen(t)}
          style={{
            display: "block", width: "100%", textAlign: "left",
            padding: "12px 12px",
            background: "var(--bg-2)", border: "1px solid var(--rule)",
            borderRadius: 10, marginBottom: 8, cursor: "pointer",
            color: "var(--fg)",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {t.title}
            </span>
            <span className="t-mono" style={{
              fontSize: 9, padding: "2px 6px", borderRadius: 999,
              background: "var(--bg-3)", color: "var(--fg-3)",
            }}>{t.messageCount}</span>
          </div>
          <div className="t-mono" style={{ marginTop: 2, fontSize: 9.5, color: "var(--fg-4)", textTransform: "uppercase", letterSpacing: "0.12em" }}>
            {relativeTime(t.lastActiveAt)}
            {t.status === "archived" && " · archived"}
          </div>
          {t.summary && (
            <div style={{
              marginTop: 6, fontSize: 12, lineHeight: 1.45, color: "var(--fg-3)",
              overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const,
            }}>{t.summary}</div>
          )}
        </button>
      ))}
    </div>
  )
}

function DayList({ onOpen }: { onOpen: (d: DaySummary) => void }) {
  const [items, setItems] = useState<DaySummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  useEffect(() => {
    let cancelled = false
    const term = search.trim()
    const url = term ? `/api/spar/days?limit=90&q=${encodeURIComponent(term)}` : "/api/spar/days?limit=90"
    const delay = term ? 300 : 0
    const t = setTimeout(() => {
      setItems(null)
      fetch(url)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: { days: DaySummary[] }) => { if (!cancelled) setItems(d.days ?? []) })
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    }, delay)
    return () => { cancelled = true; clearTimeout(t) }
  }, [search])
  if (error) return <Empty msg={`Couldn't load days (${error}).`} />
  const noResults = items !== null && items.length === 0
  return (
    <div>
      <div style={{ padding: "8px 12px 4px" }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search days..."
          style={{
            width: "100%", boxSizing: "border-box",
            padding: "8px 10px", fontSize: 12,
            background: "var(--bg-2)", border: "1px solid var(--rule)",
            borderRadius: 8, color: "var(--fg)", outline: "none",
          }}
        />
      </div>
      {items === null ? (
        <Empty msg="Loading…" />
      ) : noResults ? (
        <Empty msg={search.trim() ? `No results for "${search.trim()}".` : "No conversation history yet."} />
      ) : (
        <div style={{ padding: "4px 12px 24px" }}>
          {items.map((d) => {
            const disabled = d.activeConversationId === null
            return (
              <button
                key={d.date}
                disabled={disabled}
                onClick={() => onOpen(d)}
                style={{
                  display: "block", width: "100%", textAlign: "left",
                  padding: "12px 12px",
                  background: "var(--bg-2)", border: "1px solid var(--rule)",
                  borderRadius: 10, marginBottom: 8,
                  cursor: disabled ? "default" : "pointer",
                  opacity: disabled ? 0.5 : 1,
                  color: "var(--fg)",
                }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: "var(--fg)" }}>
                    {dayLabel(d.date)}
                  </span>
                  <span className="t-mono" style={{
                    fontSize: 9, padding: "2px 6px", borderRadius: 999,
                    background: "var(--bg-3)", color: "var(--fg-3)",
                  }}>{d.messageCount}</span>
                </div>
                {d.summary && (
                  <div style={{
                    marginTop: 6, fontSize: 12, lineHeight: 1.45, color: "var(--fg-3)",
                    overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" as const,
                  }}>{d.summary}</div>
                )}
                {d.topics.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
                    {d.topics.map((t) => (
                      <span key={t.id} style={{
                        fontSize: 9.5, padding: "2px 8px", borderRadius: 999,
                        background: "var(--bg-1)", border: "1px solid var(--rule-strong)",
                        color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.1em",
                      }}>{t.title}</span>
                    ))}
                  </div>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TopicDetail({ slug, fallbackTitle, onBack, onAskAboutThis }: { slug: string; fallbackTitle: string; onBack: () => void; onAskAboutThis?: (text: string) => void }) {
  const [data, setData] = useState<{ topic: { title: string; summary: string | null }; messages: HistoryMessage[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/spar/topics/${encodeURIComponent(slug)}/messages`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [slug])
  const topicTitle = data?.topic.title ?? fallbackTitle
  return (
    <div className="amaso-screen" style={{ background: "var(--bg-0)" }}>
      <Header title={topicTitle} onBack={onBack} />
      {data?.topic.summary && (
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--rule)", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.5 }}>
          {data.topic.summary}
        </div>
      )}
      <div className="amaso-scroll" style={{ flex: 1 }}>
        {error ? <Empty msg={`Couldn't load topic (${error}).`} />
          : data === null ? <Empty msg="Loading…" />
          : data.messages.length === 0 ? <Empty msg="No messages tied to this topic." />
          : <MessageStream messages={data.messages} />}
      </div>
      {data && data.messages.length > 0 && onAskAboutThis && (
        <div style={{ padding: "8px 12px 16px", flexShrink: 0 }}>
          <button
            onClick={() => onAskAboutThis("Tell me more about: " + topicTitle)}
            style={{
              width: "100%", padding: "10px 0", fontSize: 13,
              background: "rgba(249,115,22,0.08)", border: "1px solid rgba(249,115,22,0.28)",
              borderRadius: 10, color: "#fda26b", cursor: "pointer",
            }}
          >
            Ask AI about this
          </button>
        </div>
      )}
    </div>
  )
}

function DayDetail({ date, conversationId, onBack }: { date: string; conversationId: number; onBack: () => void }) {
  const [data, setData] = useState<{ messages: HistoryMessage[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/spar/conversations/${conversationId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (!cancelled) setData({ messages: d.messages ?? [] }) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [conversationId])
  return (
    <div className="amaso-screen" style={{ background: "var(--bg-0)" }}>
      <Header title={dayLabel(date)} onBack={onBack} />
      <div className="amaso-scroll" style={{ flex: 1 }}>
        <FactsPanel date={date} />
        {error ? <Empty msg={`Couldn't load day (${error}).`} />
          : data === null ? <Empty msg="Loading…" />
          : data.messages.length === 0 ? <Empty msg="No messages on this day." />
          : <MessageStream messages={data.messages} />}
      </div>
    </div>
  )
}

function MessageStream({ messages }: { messages: HistoryMessage[] }) {
  return (
    <div style={{ padding: "12px 12px 32px", display: "flex", flexDirection: "column", gap: 10 }}>
      {messages.map((m) => (
        <div key={m.id} style={{
          padding: "10px 12px",
          background: m.role === "assistant" ? "var(--bg-2)" : "var(--bg-1)",
          border: "1px solid var(--rule)", borderRadius: 10,
        }}>
          <div className="t-mono" style={{
            fontSize: 9, color: m.role === "assistant" ? "#f97316" : "var(--fg-4)",
            textTransform: "uppercase", letterSpacing: "0.18em", marginBottom: 4,
          }}>
            {m.role} · {absoluteTime(m.createdAt)}
          </div>
          {m.role === "assistant" ? (
            <div style={{ fontSize: 13, color: "var(--fg)", lineHeight: 1.5 }}>
              <AssistantMarkdown content={m.content} />
            </div>
          ) : (
            <div style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
              {m.content}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function Empty({ msg }: { msg: string }) {
  return (
    <div style={{ padding: "32px 16px", textAlign: "center", fontSize: 12, color: "var(--fg-4)" }}>
      {msg}
    </div>
  )
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return "just now"
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`
  if (diff < 7 * 24 * 60 * 60_000) return `${Math.floor(diff / (24 * 60 * 60_000))}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function absoluteTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  })
}

function dayLabel(dateLocal: string): string {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Amsterdam" })
  if (dateLocal === today) return "Today"
  const y = new Date()
  y.setDate(y.getDate() - 1)
  const yesterday = y.toLocaleDateString("en-CA", { timeZone: "Europe/Amsterdam" })
  if (dateLocal === yesterday) return "Yesterday"
  const [yyyy, mm, dd] = dateLocal.split("-").map(Number)
  if (!yyyy || !mm || !dd) return dateLocal
  const d = new Date(yyyy, mm - 1, dd)
  const ageDays = Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60_000))
  if (ageDays >= 0 && ageDays < 7) return d.toLocaleDateString(undefined, { weekday: "long" })
  return d.toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: ageDays > 300 ? "numeric" : undefined,
  })
}
