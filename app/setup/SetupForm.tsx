"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SetupForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setPending(true);
    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.error === "password_too_short") {
          setErr("Password must be at least 8 characters.");
        } else if (body.error === "already_initialised") {
          setErr("Setup is already complete.");
        } else {
          setErr("Setup failed.");
        }
        return;
      }
      // First-admin lands on /spar (new home for admin/team).
      router.push("/spar");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <Field label="Your name" value={name} onChange={setName} required />
      <Field
        label="Email"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
        required
      />
      <Field
        label="Password (min 8 chars)"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        required
      />
      {err && <p className="text-sm text-rose-300">{err}</p>}
      <button
        type="submit"
        disabled={pending}
        className="amaso-fx amaso-press min-h-[44px] w-full rounded-md bg-orange-500 px-3 py-2 text-base font-semibold text-neutral-950 shadow-[0_2px_12px_rgba(255,107,61,0.25)] hover:bg-orange-400 hover:shadow-[0_2px_16px_rgba(255,107,61,0.35)] disabled:bg-neutral-700 disabled:text-neutral-400 disabled:shadow-none sm:text-sm"
      >
        {pending ? "Creating…" : "Create admin account"}
      </button>
    </form>
  );
}

function Field({
  label,
  type = "text",
  value,
  onChange,
  autoComplete,
  required,
}: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-neutral-400">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        required={required}
        className="min-h-[44px] w-full rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-base outline-none transition-[border-color,box-shadow] duration-200 ease-out focus:border-orange-500/50 focus:bg-neutral-900/80 focus:shadow-[0_0_0_3px_rgba(255,107,61,0.12)] sm:min-h-0 sm:text-sm"
      />
    </label>
  );
}
