"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  Hash,
  FolderKanban,
  MessageCircle,
  Menu,
  Plus,
  Send,
  Sparkles,
  X,
  StickyNote,
  Paperclip,
  FileText,
} from "lucide-react";
import type { ChannelView, MessageView } from "@/lib/chat";

const TerminalPane = dynamic(() => import("./TerminalPane"), { ssr: false });

type Role = "admin" | "team" | "client";

interface CurrentUser {
  id: number;
  name: string;
  role: Role;
}

interface ProjectLite {
  id: string;
  name: string;
}

interface DirectoryUser {
  id: number;
  name: string;
  email: string;
  role: Role;
}

interface ChatRemark {
  id: number;
  userId: number;
  userName: string;
  projectId: string;
  path: string | null;
  line: number | null;
  category: "frontend" | "backend" | "other";
  body: string;
  createdAt: number;
  resolvedAt: number | null;
}

type FeedItem =
  | { kind: "message"; data: MessageView; sortTs: number }
  | { kind: "remark"; data: ChatRemark; sortTs: number };

export default function ChatClient({
  currentUser,
  channels: initialChannels,
  projects,
  initialChannelId,
}: {
  currentUser: CurrentUser;
  channels: ChannelView[];
  projects: ProjectLite[];
  initialChannelId: number | null;
}) {
  const [channels, setChannels] = useState<ChannelView[]>(initialChannels);
  const [activeChannelId, setActiveChannelId] = useState<number | null>(
    initialChannelId,
  );
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [remarks, setRemarks] = useState<ChatRemark[]>([]);
  const [loading, setLoading] = useState(false);
  const [body, setBody] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  // Currently-open full-screen image. null = no overlay shown.
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [showNewDm, setShowNewDm] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiProjectId, setAiProjectId] = useState<string | null>(null);
  // Channel drawer visibility on mobile — desktop always shows the sidebar.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Per-channel unread counts; server is source of truth, we poke it on
  // WS events + after read POSTs so the UI stays responsive without
  // waiting for the Topbar's 15s poll.
  const [unread, setUnread] = useState<Record<number, number>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const subscribedRef = useRef<number | null>(null);
  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  // Keyboard inset (iOS). Same trick as TerminalPane: reserve the keyboard
  // height as padding-bottom so iOS doesn't scroll the body to reveal the
  // focused input — that scroll was what pushed Topbar + channel header
  // off the top on keyboard open.
  const [kbInset, setKbInset] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;
    let rafId: number | null = null;
    function update() {
      if (rafId != null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        const inset = Math.max(
          0,
          window.innerHeight - vv!.height - vv!.offsetTop,
        );
        setKbInset(inset);
      });
    }
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      if (rafId != null) window.cancelAnimationFrame(rafId);
    };
  }, []);

  const activeChannel = useMemo(
    () => channels.find((c) => c.id === activeChannelId) ?? null,
    [channels, activeChannelId],
  );

  // Load messages + remarks for active channel
  const loadChannel = useCallback(async (channelId: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/chat/channels/${channelId}/messages`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setMessages([]);
        setRemarks([]);
        return;
      }
      const data = (await res.json()) as {
        messages: MessageView[];
        remarks: ChatRemark[];
      };
      setMessages(data.messages ?? []);
      setRemarks(data.remarks ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeChannelId == null) return;
    loadChannel(activeChannelId);
  }, [activeChannelId, loadChannel]);

  // Deep-link via ?channel=123 — used by notification-click handlers so a
  // tap on a push opens the right conversation. Runs once on mount and
  // whenever the SW posts an `amaso:navigate` message (we're already open
  // but on the wrong URL).
  useEffect(() => {
    function applyFromUrl() {
      const url = new URL(window.location.href);
      const want = Number(url.searchParams.get("channel"));
      if (!Number.isFinite(want) || want <= 0) return;
      if (!channels.some((c) => c.id === want)) return;
      setActiveChannelId(want);
      // Clean the query so a browser back doesn't re-trigger it.
      url.searchParams.delete("channel");
      window.history.replaceState({}, "", url.pathname + url.hash);
    }
    applyFromUrl();
    function onSwMessage(ev: MessageEvent) {
      const d = ev.data;
      if (d && d.type === "amaso:navigate" && typeof d.url === "string") {
        const next = new URL(d.url, window.location.origin);
        window.history.replaceState({}, "", next.pathname + next.search);
        applyFromUrl();
      }
    }
    navigator.serviceWorker?.addEventListener?.("message", onSwMessage);
    return () => {
      navigator.serviceWorker?.removeEventListener?.("message", onSwMessage);
    };
  }, [channels]);

  // Mark the active channel read and clear its local unread counter.
  // Fires on channel switch + whenever the feed grows (so messages you're
  // already watching don't leave a stale badge behind).
  const markRead = useCallback(async (channelId: number) => {
    setUnread((cur) => {
      if (!cur[channelId]) return cur;
      const { [channelId]: _drop, ...rest } = cur;
      void _drop;
      return rest;
    });
    try {
      await fetch(`/api/chat/channels/${channelId}/read`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ts: Date.now() }),
      });
      // Nudge the Topbar to refresh its total immediately.
      window.dispatchEvent(new CustomEvent("amaso:unread-changed"));
    } catch {
      /* best effort */
    }
  }, []);

  // Initial unread snapshot + refresh when the tab becomes visible again.
  const refreshUnread = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/unread", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { byChannel: Record<number, number> };
      setUnread(data.byChannel ?? {});
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    void refreshUnread();
    const onVis = () => {
      if (document.visibilityState === "visible") void refreshUnread();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refreshUnread]);

  // Whenever the active channel changes, mark it read.
  useEffect(() => {
    if (activeChannelId == null) return;
    void markRead(activeChannelId);
  }, [activeChannelId, markRead]);

  // Reload channels list (for DM creation)
  const reloadChannels = useCallback(async () => {
    const res = await fetch("/api/chat/channels", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { channels: ChannelView[] };
    setChannels(data.channels ?? []);
  }, []);

  // WebSocket wiring
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/api/sync`);
    wsRef.current = ws;

    ws.onmessage = (e) => {
      let msg: {
        type: string;
        channelId?: number;
        message?: MessageView;
        projectId?: string;
        remarkId?: number;
      };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "chat:message" && msg.message && msg.channelId) {
        const isActive = msg.channelId === subscribedRef.current;
        const isOwn = msg.message.userId === currentUser.id;
        if (isActive) {
          setMessages((cur) => {
            if (cur.some((m) => m.id === msg.message!.id)) return cur;
            return [...cur, msg.message!];
          });
          // Active channel → keep the read-watermark ahead of incoming
          // messages so the Topbar badge doesn't start ticking up while
          // the user is literally reading.
          if (!isOwn) void markRead(msg.channelId);
        } else if (!isOwn) {
          // Inactive channel → bump per-channel badge + tell the Topbar
          // its global total just changed.
          setUnread((cur) => ({
            ...cur,
            [msg.channelId!]: (cur[msg.channelId!] ?? 0) + 1,
          }));
          window.dispatchEvent(new CustomEvent("amaso:unread-changed"));
        }
      } else if (
        msg.type === "chat:remark" &&
        msg.channelId &&
        msg.projectId &&
        msg.remarkId
      ) {
        if (msg.channelId !== subscribedRef.current) return;
        // Refetch the channel — simplest way to get the full remark row.
        loadChannel(msg.channelId);
      }
    };

    return () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    };
  }, [loadChannel]);

  // Track which channel is "active" (foreground) so the WS handler can tell
  // whether to append the message or bump an unread badge. We subscribe to
  // EVERY visible channel so background-channel messages still arrive.
  useEffect(() => {
    subscribedRef.current = activeChannelId;
  }, [activeChannelId]);

  // Subscribe to every visible channel on mount (and re-subscribe when the
  // list changes, e.g. after a DM is created). The WS server only forwards
  // chat:message events to subscribed clients, so this is what lets
  // background channels tick up their badges.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    const subscribeAll = () => {
      for (const c of channels) {
        ws.send(JSON.stringify({ type: "chat:subscribe", channelId: c.id }));
      }
    };
    if (ws.readyState === WebSocket.OPEN) {
      subscribeAll();
    } else {
      ws.addEventListener("open", subscribeAll, { once: true });
    }
  }, [channels]);

  // Auto-scroll to bottom when the feed grows
  useEffect(() => {
    const el = feedScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, remarks]);

  // When switching to a project channel, preselect that project for /ai
  useEffect(() => {
    if (activeChannel?.kind === "project" && activeChannel.projectId) {
      setAiProjectId(activeChannel.projectId);
    }
    setAiOpen(false);
  }, [activeChannel?.id, activeChannel?.kind, activeChannel?.projectId]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (activeChannelId == null) return;
      const trimmed = text.trim();
      // Allow empty body only when there's at least one staged attachment.
      if (!trimmed && pendingFiles.length === 0) return;

      // Slash-command: /ai (admin-only). Two flavours:
      //   "/ai"              → open the xterm pane for interactive Claude use
      //   "/ai <prompt>"     → call the Claude CLI non-interactively and post
      //                        its output back into this chat inline.
      const aiMatch = trimmed.match(/^\/ai\b\s*([\s\S]*)$/i);
      if (aiMatch) {
        if (currentUser.role !== "admin") return;
        const aiPrompt = aiMatch[1].trim();

        // Resolve which project the run targets — prefer explicit selection,
        // then the active project channel, then (if only one project exists)
        // just pick it.
        let resolvedProjectId = aiProjectId;
        if (!resolvedProjectId) {
          if (activeChannel?.kind === "project" && activeChannel.projectId) {
            resolvedProjectId = activeChannel.projectId;
            setAiProjectId(resolvedProjectId);
          } else if (projects.length === 1) {
            resolvedProjectId = projects[0].id;
            setAiProjectId(resolvedProjectId);
          }
        }

        setBody("");

        // Post the command as an ai_session message so everyone in the
        // channel sees what was asked (matches the old behaviour).
        try {
          await fetch(`/api/chat/channels/${activeChannelId}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              body: trimmed,
              kind: "ai_session",
              meta: { projectId: resolvedProjectId },
            }),
          });
        } catch {
          /* best effort */
        }

        // No prompt or no project → fall back to the interactive terminal
        // pane so the admin can still drive Claude by hand.
        if (!aiPrompt || !resolvedProjectId) {
          setAiOpen(true);
          return;
        }

        // Fire-and-forget: server runs Claude, posts output back over WS.
        try {
          await fetch(`/api/chat/channels/${activeChannelId}/ai`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              projectId: resolvedProjectId,
              prompt: aiPrompt,
            }),
          });
        } catch {
          /* best effort */
        }
        return;
      }

      setSending(true);
      // Stage the files locally so a resend error doesn't lose them; the
      // state is cleared inside the try block once the POST dispatches.
      const filesToSend = pendingFiles;
      try {
        if (filesToSend.length > 0) {
          const fd = new FormData();
          fd.append("body", trimmed);
          fd.append("kind", "text");
          for (const f of filesToSend) fd.append("files", f, f.name);
          setPendingFiles([]);
          await fetch(`/api/chat/channels/${activeChannelId}/messages`, {
            method: "POST",
            body: fd,
          });
        } else {
          await fetch(`/api/chat/channels/${activeChannelId}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ body: trimmed, kind: "text" }),
          });
        }
        setBody("");
      } finally {
        setSending(false);
      }
    },
    [
      activeChannel,
      activeChannelId,
      aiProjectId,
      currentUser.role,
      pendingFiles,
      projects,
    ],
  );

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [];
    for (const m of messages) {
      items.push({ kind: "message", data: m, sortTs: m.createdAt });
    }
    for (const r of remarks) {
      items.push({ kind: "remark", data: r, sortTs: r.createdAt });
    }
    items.sort((a, b) => a.sortTs - b.sortTs);
    return items;
  }, [messages, remarks]);

  const grouped = useMemo(() => groupChannels(channels), [channels]);

  // On mobile, tapping a channel should dismiss the drawer so the user
  // lands straight in the conversation. Desktop keeps the sidebar visible.
  const pickChannel = (id: number) => {
    setActiveChannelId(id);
    setSidebarOpen(false);
  };

  return (
    <div
      className="relative flex flex-1 overflow-hidden"
      style={kbInset > 0 ? { paddingBottom: kbInset } : undefined}
    >
      {/* Mobile backdrop — tappable to dismiss the channel drawer. */}
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close channels"
          onClick={() => setSidebarOpen(false)}
          className="absolute inset-0 z-20 bg-black/50 sm:hidden"
        />
      )}
      {/* Sidebar. Desktop: always visible static column. Mobile: slide-in
          drawer from the left, dismissed via the backdrop or channel tap. */}
      <aside
        className={`${
          sidebarOpen ? "flex" : "hidden"
        } absolute inset-y-0 left-0 z-30 w-64 flex-shrink-0 flex-col border-r border-neutral-800 bg-neutral-950 text-sm shadow-xl sm:static sm:flex sm:w-56 sm:bg-neutral-950/60 sm:shadow-none`}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2 text-xs uppercase tracking-wide text-neutral-500">
          <span>Channels</span>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 sm:hidden"
            aria-label="Close channels"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="thin-scroll flex-1 overflow-auto py-1">
          <Section label="General">
            {grouped.general.map((c) => (
              <ChannelRow
                key={c.id}
                channel={c}
                active={c.id === activeChannelId}
                unread={unread[c.id] ?? 0}
                onClick={() => pickChannel(c.id)}
              />
            ))}
          </Section>
          {grouped.project.length > 0 && (
            <Section label="Projects">
              {grouped.project.map((c) => (
                <ChannelRow
                  key={c.id}
                  channel={c}
                  active={c.id === activeChannelId}
                  unread={unread[c.id] ?? 0}
                  onClick={() => pickChannel(c.id)}
                />
              ))}
            </Section>
          )}
          <Section
            label="Direct messages"
            action={
              <button
                type="button"
                onClick={() => setShowNewDm(true)}
                className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                title="Start a DM"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            }
          >
            {grouped.dm.length === 0 ? (
              <p className="px-3 py-1.5 text-[11px] text-neutral-500">
                No DMs yet.
              </p>
            ) : (
              grouped.dm.map((c) => (
                <ChannelRow
                  key={c.id}
                  channel={c}
                  active={c.id === activeChannelId}
                  unread={unread[c.id] ?? 0}
                  onClick={() => pickChannel(c.id)}
                />
              ))
            )}
          </Section>
        </div>
      </aside>

      {/* Main */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-shrink-0 items-center gap-2 border-b border-neutral-800 px-2 py-1.5 sm:px-4 sm:py-2">
          {/* Mobile-only channel drawer toggle */}
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200 sm:hidden"
            aria-label="Open channels"
          >
            <Menu className="h-5 w-5" />
          </button>
          <ChannelIcon channel={activeChannel} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-medium">
              {activeChannel?.name ?? "Select a channel"}
            </h1>
            {activeChannel?.kind === "project" && (
              <p className="truncate text-[11px] text-neutral-500">
                Project remarks appear inline.
              </p>
            )}
          </div>
          {activeChannel && currentUser.role === "admin" && (
            <button
              type="button"
              onClick={() => setAiOpen((v) => !v)}
              className={`flex min-h-[40px] flex-shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition sm:min-h-0 sm:px-2 ${
                aiOpen
                  ? "border-orange-700 bg-orange-900/30 text-orange-200"
                  : "border-neutral-800 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200"
              }`}
              title="Toggle Claude CLI terminal"
              aria-label={aiOpen ? "Close AI terminal" : "Launch AI terminal"}
            >
              <Sparkles className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              <span className="hidden sm:inline">{aiOpen ? "Close AI" : "Launch AI"}</span>
            </button>
          )}
        </header>

        {aiOpen ? (
          <div className="flex flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-900/60 px-3 py-1.5 text-xs">
              <span className="text-neutral-400">AI terminal · project:</span>
              <select
                value={aiProjectId ?? ""}
                onChange={(e) => setAiProjectId(e.target.value || null)}
                className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-xs"
              >
                <option value="">— pick a project —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setAiOpen(false)}
                className="ml-auto rounded p-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                title="Back to chat"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex-1 bg-[#0b0d10]">
              {aiProjectId ? (
                <TerminalPane
                  projectId={aiProjectId}
                  canManage={currentUser.role === "admin"}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-neutral-500">
                  Pick a project above to start the Claude CLI session.
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div
              ref={feedScrollRef}
              className="thin-scroll flex-1 space-y-2 overflow-auto px-4 py-3"
            >
              {!activeChannel ? (
                <EmptyHint>Pick a channel on the left.</EmptyHint>
              ) : loading ? (
                <EmptyHint>Loading…</EmptyHint>
              ) : feed.length === 0 ? (
                <EmptyHint>
                  No messages yet. Say hi{activeChannel.kind === "general" ? " to the team" : ""}.
                </EmptyHint>
              ) : (
                feed.map((it) =>
                  it.kind === "message" ? (
                    <MessageBubble
                      key={`m${it.data.id}`}
                      message={it.data}
                      isOwn={it.data.userId === currentUser.id}
                      onImageClick={setLightboxUrl}
                    />
                  ) : (
                    <RemarkCard key={`r${it.data.id}`} remark={it.data} />
                  ),
                )
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void sendMessage(body);
              }}
              className="pb-safe pl-safe pr-safe border-t border-neutral-800 p-3"
            >
              {pendingFiles.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {pendingFiles.map((f, idx) => (
                    <PendingFilePreview
                      key={`${f.name}-${idx}`}
                      file={f}
                      onRemove={() =>
                        setPendingFiles((prev) =>
                          prev.filter((_, i) => i !== idx),
                        )
                      }
                    />
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                {/* Hidden file input lives outside the button so the native
                 *  widget never renders — we just click() it on demand. */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,application/pdf"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const picked = Array.from(e.target.files ?? []);
                    if (picked.length === 0) return;
                    setPendingFiles((prev) => [...prev, ...picked].slice(0, 5));
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!activeChannel}
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300 disabled:opacity-40"
                  title="Voeg foto of bestand toe"
                  aria-label="Voeg bestand toe"
                >
                  <Paperclip className="h-4 w-4" />
                </button>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void sendMessage(body);
                    }
                  }}
                  rows={1}
                  placeholder={
                    activeChannel
                      ? "Message…"
                      : "Pick a channel first"
                  }
                  disabled={!activeChannel}
                  className="flex-1 resize-none rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-base outline-none focus:border-neutral-600 disabled:opacity-50 sm:text-sm"
                />
                <button
                  type="submit"
                  disabled={
                    !activeChannel ||
                    sending ||
                    (!body.trim() && pendingFiles.length === 0)
                  }
                  className="amaso-fx amaso-press flex min-h-[40px] items-center gap-1 rounded-md bg-orange-500 px-4 py-2 text-sm font-semibold text-neutral-950 shadow-[0_2px_8px_rgba(255,107,61,0.3)] hover:bg-orange-400 disabled:bg-neutral-700 disabled:text-neutral-400 disabled:shadow-none sm:min-h-0"
                  aria-label="Send message"
                >
                  <Send className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                  <span className="hidden sm:inline">Send</span>
                </button>
              </div>
              <p className="mt-1 hidden text-[10px] text-neutral-500 sm:block">
                Enter to send · Shift+Enter for a newline · <code>/ai &lt;prompt&gt;</code> runs Claude inline · <code>/ai</code> alone opens the terminal
              </p>
            </form>
          </>
        )}
      </section>

      {showNewDm && (
        <NewDmDialog
          onClose={() => setShowNewDm(false)}
          onCreated={async (channelId) => {
            await reloadChannels();
            setActiveChannelId(channelId);
            setShowNewDm(false);
          }}
        />
      )}
      {lightboxUrl && (
        <ImageLightbox
          url={lightboxUrl}
          onClose={() => setLightboxUrl(null)}
        />
      )}
    </div>
  );
}

/** Full-viewport image viewer. Tap anywhere / the ✕ / Esc to close. */
function ImageLightbox({
  url,
  onClose,
}: {
  url: string;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
        aria-label="Sluiten"
      >
        <X className="h-5 w-5" />
      </button>
      {/* Plain <img> — blob served from our own API. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt=""
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}

function groupChannels(channels: ChannelView[]) {
  return {
    general: channels.filter((c) => c.kind === "general"),
    project: channels.filter((c) => c.kind === "project"),
    dm: channels.filter((c) => c.kind === "dm"),
  };
}

function Section({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2 first:mt-0">
      <div className="flex items-center justify-between px-3 py-1 text-[10px] uppercase tracking-wide text-neutral-500">
        <span>{label}</span>
        {action}
      </div>
      <div>{children}</div>
    </div>
  );
}

function ChannelRow({
  channel,
  active,
  unread,
  onClick,
}: {
  channel: ChannelView;
  active: boolean;
  unread: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-[40px] w-full items-center gap-2 px-3 py-2 text-left text-sm transition sm:min-h-0 sm:py-1.5 sm:text-xs ${
        active
          ? "bg-neutral-800 text-white"
          : unread > 0
            ? "font-medium text-neutral-100 hover:bg-neutral-900"
            : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
      }`}
    >
      <ChannelIcon channel={channel} compact />
      <span className="flex-1 truncate">{channel.name}</span>
      {unread > 0 && !active && (
        <span className="flex-shrink-0 rounded-full bg-orange-500 px-1.5 py-0.5 text-[10px] font-semibold text-black">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}

function ChannelIcon({
  channel,
  compact,
}: {
  channel: ChannelView | null;
  compact?: boolean;
}) {
  const cls = compact ? "h-3.5 w-3.5 flex-shrink-0" : "h-4 w-4";
  if (!channel) return <Hash className={cls} />;
  if (channel.kind === "general") return <Hash className={cls} />;
  if (channel.kind === "project")
    return <FolderKanban className={`${cls} text-sky-400`} />;
  return <MessageCircle className={`${cls} text-orange-400`} />;
}

function MessageBubble({
  message,
  isOwn,
  onImageClick,
}: {
  message: MessageView;
  isOwn: boolean;
  onImageClick?: (url: string) => void;
}) {
  const attachments = message.attachments ?? [];
  return (
    <div className={`flex gap-2 ${isOwn ? "flex-row-reverse" : ""}`}>
      <div
        className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
          isOwn
            ? "bg-orange-900/40 text-orange-50"
            : "bg-neutral-900 text-neutral-100"
        }`}
      >
        <div className="mb-0.5 flex items-center gap-2 text-[10px] text-neutral-400">
          <span className="font-medium text-neutral-300">{message.userName}</span>
          <span>{relTime(message.createdAt)}</span>
          {message.kind === "ai_session" && (
            <span className="flex items-center gap-1 rounded-full border border-orange-700/60 bg-orange-900/40 px-1.5 text-[9px] text-orange-200">
              <Sparkles className="h-2.5 w-2.5" /> AI session
            </span>
          )}
        </div>
        {message.body && (
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        )}
        {attachments.length > 0 && (
          <div
            className={`grid gap-1.5 ${
              message.body ? "mt-2" : ""
            } ${attachments.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}
          >
            {attachments.map((a) => {
              const url = `/api/chat/attachments/${a.id}`;
              if (a.mimeType.startsWith("image/")) {
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => onImageClick?.(url)}
                    className="overflow-hidden rounded border border-neutral-800"
                  >
                    {/* Intentionally a plain <img> — tiny per-message
                     *  uploads served from our API with immutable cache
                     *  headers; no need for next/image optimisation. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt={a.filename}
                      className="max-h-64 w-full object-cover"
                    />
                  </button>
                );
              }
              return (
                <a
                  key={a.id}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-950/60 px-2 py-1.5 text-xs text-neutral-200 hover:border-neutral-700"
                >
                  <FileText className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="truncate">{a.filename}</span>
                  <span className="ml-auto text-[10px] text-neutral-500">
                    {formatSize(a.size)}
                  </span>
                </a>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PendingFilePreview({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  const isImage = file.type.startsWith("image/");
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file, isImage]);
  return (
    <div className="relative flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1.5 text-xs">
      {isImage && url ? (
        // Local blob preview — see note on MessageBubble for the lint-ignore.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={file.name}
          className="h-10 w-10 rounded object-cover"
        />
      ) : (
        <FileText className="h-4 w-4 text-neutral-400" />
      )}
      <div className="min-w-0">
        <div className="max-w-[160px] truncate">{file.name}</div>
        <div className="text-[10px] text-neutral-500">{formatSize(file.size)}</div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="ml-1 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
        aria-label="Verwijder bijlage"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function RemarkCard({ remark }: { remark: ChatRemark }) {
  const categoryStyle = {
    frontend: "border-sky-800/60 bg-sky-900/20 text-sky-200",
    backend: "border-violet-800/60 bg-violet-900/20 text-violet-200",
    other: "border-neutral-700 bg-neutral-800/70 text-neutral-200",
  }[remark.category];
  return (
    <div className="rounded-lg border border-amber-800/50 bg-amber-900/10 px-3 py-2">
      <div className="flex items-center gap-2 text-[10px] text-neutral-400">
        <StickyNote className="h-3 w-3 text-amber-400" />
        <span className="font-medium text-amber-200">Remark</span>
        <span className={`rounded border px-1 py-0.5 uppercase ${categoryStyle}`}>
          {remark.category}
        </span>
        <span className="text-neutral-500">·</span>
        <span className="text-neutral-300">{remark.userName}</span>
        <span className="text-neutral-500">·</span>
        <span>{relTime(remark.createdAt)}</span>
        {remark.path && (
          <span
            className="ml-1 truncate rounded bg-neutral-800/80 px-1 py-0.5 font-mono text-[9px]"
            title={remark.path}
          >
            {remark.path.split("/").slice(-2).join("/")}
            {remark.line !== null && `:${remark.line}`}
          </span>
        )}
        {remark.resolvedAt && (
          <span className="ml-auto rounded-full border border-orange-700 bg-orange-900/30 px-1.5 py-0.5 text-[9px] text-orange-200">
            resolved
          </span>
        )}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-100">
        {remark.body}
      </p>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-neutral-500">
      {children}
    </div>
  );
}

function NewDmDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (channelId: number) => void;
}) {
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/chat/users", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as { users: DirectoryUser[] };
          setUsers(data.users ?? []);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return users;
    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(n) || u.email.toLowerCase().includes(n),
    );
  }, [users, q]);

  async function start(userId: number) {
    setPending(userId);
    try {
      const res = await fetch("/api/chat/dm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { channelId: number };
      onCreated(data.channelId);
    } finally {
      setPending(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-950 p-3 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">Start a DM</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search users…"
          className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm outline-none focus:border-neutral-600"
          autoFocus
        />
        <div className="thin-scroll mt-2 max-h-72 overflow-auto">
          {loading ? (
            <p className="px-2 py-4 text-xs text-neutral-500">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-4 text-xs text-neutral-500">
              No users match.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-900">
              {filtered.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => start(u.id)}
                    disabled={pending === u.id}
                    className="flex w-full items-center gap-2 px-2 py-2 text-left text-sm hover:bg-neutral-900 disabled:opacity-40"
                  >
                    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-neutral-800 text-xs text-neutral-300">
                      {u.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{u.name}</div>
                      <div className="truncate text-[11px] text-neutral-500">
                        {u.email}
                      </div>
                    </div>
                    <span className="rounded border border-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                      {u.role}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}
