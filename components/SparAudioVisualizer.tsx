"use client";

import { useEffect, useRef, type RefObject } from "react";

export default function SparAudioVisualizer({
  analyserRef,
  inCall,
  listening,
  speaking,
  thinking,
  autopilot = false,
}: {
  analyserRef: RefObject<AnalyserNode | null>;
  inCall: boolean;
  listening: boolean;
  speaking: boolean;
  thinking: boolean;
  autopilot?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Refs so the draw loop always reads current state without restarting.
  const flagsRef = useRef({ inCall, listening, speaking, thinking, autopilot });
  flagsRef.current = { inCall, listening, speaking, thinking, autopilot };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const NUM_BARS = 96;
    const TWO_PI = Math.PI * 2;

    const heights = new Float32Array(NUM_BARS);
    const data = new Uint8Array(128);

    let lastW = 0;
    let lastH = 0;
    const dpr = window.devicePixelRatio || 1;

    let raf = 0;
    let idleSeed = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const f = flagsRef.current;

      const rect = canvas.getBoundingClientRect();
      const W = Math.max(1, Math.round(rect.width));
      const H = Math.max(1, Math.round(rect.height));
      if (W !== lastW || H !== lastH) {
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        lastW = W;
        lastH = H;
      }
      // Wipe the backing store AND force the context back to a known
      // pristine state every frame. Belt-and-braces: if any future code
      // path ever sets a shadow/gradient/compositing mode and forgets to
      // reset it, the center of the visualizer still stays empty.
      ctx.clearRect(0, 0, W, H);
      ctx.shadowBlur = 0;
      ctx.shadowColor = "rgba(0,0,0,0)";
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.filter = "none";

      const CENTER_X = W / 2;
      const CENTER_Y = H / 2;
      const SHORT = Math.min(W, H);
      const INNER_R = SHORT * 0.28;
      const BASE_BAR = 2;
      const MAX_BAR = SHORT * 0.48 - INNER_R;

      const analyser = analyserRef.current;
      const haveAudio = analyser != null && f.speaking;
      if (haveAudio) {
        analyser!.getByteFrequencyData(data);
      }

      idleSeed += 1;

      // Autopilot aura — emerald shadow painted directly on each bar
      // stroke, so the glow hugs the ring of bars instead of filling the
      // hollow center. Breathes on a slow sine and swells with audio.
      if (f.autopilot) {
        let audioEnergy = 0;
        if (haveAudio) {
          let sum = 0;
          const lim = Math.min(32, data.length);
          for (let k = 0; k < lim; k++) sum += data[k];
          audioEnergy = Math.min(1, sum / (lim * 180));
        }
        const breath = 0.5 + 0.5 * Math.sin(idleSeed * 0.055);
        const shadowBlur = 8 + 10 * breath + 16 * audioEnergy;
        const shadowAlpha = Math.min(
          0.9,
          0.4 + 0.2 * breath + 0.3 * audioEnergy,
        );
        ctx.shadowBlur = shadowBlur;
        ctx.shadowColor = `rgba(74,222,128,${shadowAlpha})`;
      } else {
        ctx.shadowBlur = 0;
        ctx.shadowColor = "rgba(0,0,0,0)";
      }

      for (let i = 0; i < NUM_BARS; i++) {
        const half = NUM_BARS / 2;
        const mirror = i < half ? i : NUM_BARS - 1 - i;
        const binIdx = Math.min(
          data.length - 1,
          2 + Math.floor((mirror / half) * (data.length * 0.55)),
        );
        let target: number;
        if (haveAudio) {
          target = Math.min(1.25, Math.pow(data[binIdx] / 200, 0.75));
        } else if (f.thinking) {
          target = 0.12 + 0.08 * Math.sin(idleSeed * 0.06 + i * 0.12);
        } else if (f.listening) {
          target = 0.06 + 0.04 * Math.sin(idleSeed * 0.1 + i * 0.3);
        } else if (f.inCall) {
          target = 0.04 + 0.02 * Math.sin(idleSeed * 0.04 + i * 0.2);
        } else {
          target = 0.02;
        }
        const cur = heights[i];
        const k = target > cur ? 0.62 : 0.14;
        heights[i] = cur + (target - cur) * k;

        const mag = heights[i];
        const len = BASE_BAR + mag * MAX_BAR;
        const angle = (i / NUM_BARS) * TWO_PI - Math.PI / 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const x1 = CENTER_X + cos * INNER_R;
        const y1 = CENTER_Y + sin * INNER_R;
        const x2 = CENTER_X + cos * (INNER_R + len);
        const y2 = CENTER_Y + sin * (INNER_R + len);

        let r: number, g: number, b: number;
        if (f.speaking) {
          r = 52;
          g = 211;
          b = 153;
        } else if (f.thinking) {
          r = 251;
          g = 191;
          b = 36;
        } else if (f.listening) {
          r = 248;
          g = 113;
          b = 113;
        } else {
          r = 16;
          g = 185;
          b = 129;
        }
        const alpha = 0.3 + Math.min(1, mag) * 0.65;

        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.lineWidth = 2 + Math.min(1, mag) * 1.6;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      ctx.shadowBlur = 0;
      ctx.shadowColor = "rgba(0,0,0,0)";
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [analyserRef]);

  return <canvas ref={canvasRef} className="block h-full w-full" />;
}
