"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { OnMount } from "@monaco-editor/react";
import type * as MonacoApi from "monaco-editor";
import { detectLanguage } from "@/lib/language";
import type { Remark } from "./RemarksPanel";

const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.default),
  { ssr: false, loading: () => <Info>Loading editor…</Info> },
);

interface FileResponse {
  path: string;
  size: number;
  binary: boolean;
  truncated?: boolean;
  content: string | null;
}

export default function FileViewer({
  projectId,
  path,
  remarks,
  onGutterClick,
  scrollToLine,
}: {
  projectId: string;
  path: string;
  remarks: Remark[];
  onGutterClick: (line: number) => void;
  /** If set, Monaco centres on this line once content is loaded. */
  scrollToLine?: number | null;
}) {
  const [data, setData] = useState<FileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<MonacoApi.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  const decorationsRef =
    useRef<MonacoApi.editor.IEditorDecorationsCollection | null>(null);

  // Fetch file content
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    const url = `/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`;
    fetch(url, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as FileResponse;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, path]);

  // Refresh gutter decorations whenever remarks change
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const lined = remarks.filter((r) => r.line !== null);
    const deltas: MonacoApi.editor.IModelDeltaDecoration[] = lined.map(
      (r) => ({
        range: new monaco.Range(r.line!, 1, r.line!, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: "remark-gutter",
          overviewRuler: {
            color: "#f59e0b",
            position: monaco.editor.OverviewRulerLane.Left,
          },
          hoverMessage: { value: `**${r.userName}**: ${r.body}` },
        },
      }),
    );
    if (!decorationsRef.current) {
      decorationsRef.current = editor.createDecorationsCollection(deltas);
    } else {
      decorationsRef.current.set(deltas);
    }
  }, [remarks]);

  // Scroll Monaco to the requested line when one arrives (e.g. after an
  // Alt+click in the Preview tab). Waits for content to load first.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    if (!data || data.binary || data.truncated) return;
    if (!scrollToLine || scrollToLine < 1) return;
    // Reveal + highlight briefly so the user sees where we landed
    editor.revealLineInCenter(scrollToLine, monaco.editor.ScrollType.Smooth);
    editor.setPosition({ lineNumber: scrollToLine, column: 1 });
    const flash = editor.createDecorationsCollection([
      {
        range: new monaco.Range(scrollToLine, 1, scrollToLine, 1),
        options: {
          isWholeLine: true,
          className: "monaco-flash-line",
        },
      },
    ]);
    const t = window.setTimeout(() => flash.clear(), 1800);
    return () => window.clearTimeout(t);
  }, [scrollToLine, data]);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.onMouseDown((e) => {
      if (
        e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS ||
        e.target.type ===
          monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
      ) {
        const line = e.target.position?.lineNumber;
        if (line) onGutterClick(line);
      }
    });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2 text-xs text-neutral-400">
        <span className="truncate font-mono">{path}</span>
        {data && <span>{formatBytes(data.size)}</span>}
      </div>
      <div className="flex-1 overflow-hidden">
        {error && <Info>Error: {error}</Info>}
        {!data && !error && <Info>Loading…</Info>}
        {data?.binary && <Info>Binary file — preview not available.</Info>}
        {data?.truncated && (
          <Info>
            File is larger than the 2 MB preview limit (
            {formatBytes(data.size)}).
          </Info>
        )}
        {data && !data.binary && !data.truncated && data.content !== null && (
          <>
            <style>{`
              .remark-gutter {
                background: #f59e0b;
                width: 3px !important;
                margin-left: 3px;
              }
            `}</style>
            <MonacoEditor
              height="100%"
              value={data.content}
              language={detectLanguage(path)}
              theme="vs-dark"
              path={`${projectId}/${path}`}
              onMount={handleMount}
              options={{
                readOnly: true,
                domReadOnly: true,
                minimap: { enabled: true },
                fontSize: 13,
                lineNumbers: "on",
                scrollBeyondLastLine: false,
                automaticLayout: true,
                wordWrap: "off",
                renderWhitespace: "selection",
                smoothScrolling: true,
                glyphMargin: true,
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

function Info({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-sm text-neutral-500">{children}</div>;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
