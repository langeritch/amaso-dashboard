"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSpar } from "./SparContext";
import SparAudioVisualizer from "./SparAudioVisualizer";

export default function SparMiniOverlay() {
  const pathname = usePathname();
  const router = useRouter();
  const {
    inCall,
    listening,
    micMuted,
    ttsIdle,
    busy,
    analyserRef,
  } = useSpar();

  // Mini is wanted on every non-/spar page while a call is active.
  // pathname can be null during the very first SSR-to-client handoff;
  // treat null as "not /spar" so an in-progress call keeps its mini
  // visible across that brief gap.
  const wantsShow = inCall && pathname !== "/spar";

  // Two-state lifecycle so transitions play in BOTH directions:
  //   mounted → controls whether the node is in the DOM
  //   visible → controls the opacity/scale class
  // On show: mount first, then flip visible after a *double* rAF.
  // A single rAF runs in the same frame React commits the mount, so
  // the browser would batch the hidden→visible style change into one
  // paint and the transition would never fire visually. Double rAF
  // guarantees frame 1 paints the hidden starting position before
  // frame 2 flips to visible.
  // On hide: flip visible to false now and unmount after the
  // transition has played out.
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (wantsShow) {
      setMounted(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setVisible(false);
    // Match the CSS exit transition below (650ms) plus a small buffer
    // so the unmount never clips the shrink-out animation.
    const t = window.setTimeout(() => setMounted(false), 700);
    return () => window.clearTimeout(t);
  }, [wantsShow]);

  if (!mounted) return null;

  return (
    <button
      type="button"
      onClick={() => router.push("/spar")}
      aria-label="Open Spar"
      style={{
        // Respect iOS home indicator / right-edge safe area on the
        // fixed offset itself rather than padding the button (padding
        // would shrink the visualizer canvas via its absolute inset-0).
        bottom: "max(1rem, calc(env(safe-area-inset-bottom) + 0.5rem))",
        right: "max(1rem, calc(env(safe-area-inset-right) + 0.5rem))",
      }}
      className={`fixed z-50 flex h-24 w-24 items-center justify-center bg-transparent origin-bottom-right transition-[opacity,transform] duration-[650ms] ${
        visible
          ? "translate-x-0 translate-y-0 scale-100 opacity-100 ease-out"
          : "pointer-events-none translate-x-[40%] translate-y-[40%] scale-50 opacity-0 ease-in"
      }`}
    >
      <span className="absolute inset-0">
        <SparAudioVisualizer
          analyserRef={analyserRef}
          inCall={inCall}
          listening={listening && !micMuted}
          speaking={!ttsIdle}
          thinking={busy}
        />
      </span>
    </button>
  );
}
