"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function ProjectsLiveRefresh() {
  const router = useRouter();

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    let ws: WebSocket | null = null;
    let closed = false;

    function connect() {
      if (closed) return;
      ws = new WebSocket(`${proto}//${window.location.host}/api/sync`);
      ws.addEventListener("message", (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "projects:changed") {
            router.refresh();
          }
        } catch {}
      });
      ws.addEventListener("close", () => {
        if (!closed) setTimeout(connect, 3000);
      });
    }

    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [router]);

  return null;
}
