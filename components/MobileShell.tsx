"use client"
import { useState, useEffect } from "react"
import dynamic from "next/dynamic"
import type { MobileUser } from "./mobile/types"

const MobileApp = dynamic(() => import("./mobile/app"), { ssr: false })

// Must match CACHE_VERSION in public/sw.js. Used to detect stale SWs on cold
// standalone launches where sessionStorage is empty and the version-change
// path never fires.
const SW_EXPECTED_VERSION = "v61-2026-05-14-topic-visibility"

interface Props {
  user?: MobileUser
}

export default function MobileShell({ user }: Props) {
  const [isMobile, setIsMobile] = useState(false)
  const [ready, setReady] = useState(false)

  // ── Nuclear one-time cache bust ────────────────────────────────────────────
  // Runs once per device (localStorage flag). Unregisters every SW and deletes
  // every cache so standalone installs stuck on a stale bundle get a clean
  // slate. The flag is set before reload so it never runs twice.
  useEffect(() => {
    const NUKE_KEY = "sw-nuke-2026-05-11"
    if (!("serviceWorker" in navigator)) return
    if (localStorage.getItem(NUKE_KEY)) return
    ;(async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map(r => r.unregister()))
        const cacheKeys = await caches.keys()
        await Promise.all(cacheKeys.map(k => caches.delete(k)))
      } catch {}
      localStorage.setItem(NUKE_KEY, "1")
      window.location.reload()
    })()
  }, [])

  // ── Build-constant version gate ────────────────────────────────────────────
  // On every cold launch (sessionStorage empty = standalone was closed and
  // reopened), force registration.update(). If a waiting worker is found,
  // skip-wait it immediately rather than relying on the isMobile-gated flow
  // that runs later. Guards with sessionStorage so it only fires once per
  // browser session, not on every soft navigation.
  useEffect(() => {
    const CONFIRMED_KEY = `amaso:sw-confirmed:${SW_EXPECTED_VERSION}`
    if (!("serviceWorker" in navigator)) return
    if (sessionStorage.getItem(CONFIRMED_KEY)) return
    if (document.visibilityState !== "visible") return
    ;(async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration()
        if (!reg) { sessionStorage.setItem(CONFIRMED_KEY, "1"); return }
        await reg.update().catch(() => {})
        if (reg.waiting) {
          reg.waiting.postMessage({ type: "SKIP_WAITING" })
          window.location.reload()
          return
        }
      } catch {}
      sessionStorage.setItem(CONFIRMED_KEY, "1")
    })()
  }, [])

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)")
    setIsMobile(mq.matches)
    setReady(true)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener("change", handler)
    return () => mq.removeEventListener("change", handler)
  }, [])

  useEffect(() => {
    if (!isMobile) return
    const b = document.body
    const h = document.documentElement
    const prev = { overflow: b.style.overflow, position: b.style.position, width: b.style.width, height: b.style.height, top: b.style.top }
    b.style.overflow = "hidden"
    b.style.position = "fixed"
    b.style.width = "100%"
    b.style.height = "100%"
    b.style.top = "0"
    h.style.overflow = "hidden"

    const shell = document.querySelector<HTMLElement>(".amaso-mobile-shell")
    let siblings: HTMLElement[] = []
    let prevDisplay: string[] = []
    if (shell && shell.parentElement) {
      siblings = Array.from(shell.parentElement.children).filter(el => el !== shell && !el.classList.contains("amaso-intro")) as HTMLElement[]
      prevDisplay = siblings.map(el => el.style.display)
      siblings.forEach(el => { el.style.display = "none" })
    }

    return () => {
      b.style.overflow = prev.overflow
      b.style.position = prev.position
      b.style.width = prev.width
      b.style.height = prev.height
      b.style.top = prev.top
      h.style.overflow = ""
      siblings.forEach((el, i) => { el.style.display = prevDisplay[i] })
    }
  }, [isMobile])

  useEffect(() => {
    if (!isMobile) return
    let reloading = false
    const VERSION_KEY = "amaso:server-version"

    const triggerReload = () => {
      if (reloading) return
      reloading = true
      window.location.reload()
    }

    const wireUpdateFound = (reg: ServiceWorkerRegistration) => {
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing
        if (!sw) return
        sw.addEventListener("statechange", () => {
          // Only skip-wait when there is an existing controller — a first-time
          // install has no old page to reload, so we let it activate normally.
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            sw.postMessage({ type: "SKIP_WAITING" })
            triggerReload()
          }
        })
      })
    }

    const checkSW = async () => {
      if (!("serviceWorker" in navigator)) return
      try {
        const reg = await navigator.serviceWorker.getRegistration()
        if (!reg) return
        wireUpdateFound(reg)
        await reg.update().catch(() => {})
        if (reg.waiting) {
          reg.waiting.postMessage({ type: "SKIP_WAITING" })
          triggerReload()
        }
      } catch {}
    }

    const checkVersion = async () => {
      if (reloading) return
      try {
        const res = await fetch("/api/version", { cache: "no-store" })
        if (!res.ok) return
        const { version } = await res.json()
        if (!version) return
        const stored = sessionStorage.getItem(VERSION_KEY)
        sessionStorage.setItem(VERSION_KEY, String(version))
        if (!stored) {
          // Cold launch: no version stored yet. Run a SW update check so a
          // waiting worker (deployed while the PWA was closed) activates now
          // instead of waiting for a second open.
          await checkSW()
          return
        }
        if (String(version) === stored) return
        await checkSW()
        triggerReload()
      } catch {}
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", triggerReload)
    }

    checkSW()
    checkVersion()
    const onVis = () => {
      if (document.visibilityState === "visible") {
        checkSW()
        checkVersion()
      }
    }
    document.addEventListener("visibilitychange", onVis)
    return () => {
      document.removeEventListener("visibilitychange", onVis)
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("controllerchange", triggerReload)
      }
    }
  }, [isMobile])

  if (!ready || !isMobile) return null

  return (
    <div
      className="amaso-mobile-shell"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        background: "#0a0a0c",
        overflow: "hidden",
      }}
    >
      <MobileApp user={user} />
    </div>
  )
}
