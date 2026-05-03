"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, X } from "lucide-react";

type Visibility = "team" | "client" | "public";

interface FormState {
  id: string;
  name: string;
  path: string;
  subPath: string;
  visibility: Visibility;
  previewUrl: string;
  liveUrl: string;
  devPort: string;
  devCommand: string;
  deployBranch: string;
}

const EMPTY: FormState = {
  id: "",
  name: "",
  path: "",
  subPath: "",
  visibility: "team",
  previewUrl: "",
  liveUrl: "",
  devPort: "",
  devCommand: "",
  deployBranch: "",
};

/** Admin-only CTA on the projects list. Opens a modal with a minimal form —
 *  id, name, disk path, visibility are required; the rest are optional and
 *  can still be edited directly in amaso.config.json for power-user fields. */
export default function NewProjectButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  /** Derive an id slug from a name the first time the user types the name,
   *  so people don't have to think about URL slugs if the default works. */
  function onNameChange(value: string) {
    update("name", value);
    if (!form.id) {
      const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
      if (slug) update("id", slug);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        id: form.id,
        name: form.name,
        visibility: form.visibility,
      };
      if (form.path.trim()) payload.path = form.path.trim();
      if (form.subPath.trim()) payload.subPath = form.subPath.trim();
      if (form.previewUrl.trim()) payload.previewUrl = form.previewUrl.trim();
      if (form.liveUrl.trim()) payload.liveUrl = form.liveUrl.trim();
      if (form.devPort.trim()) {
        const port = Number(form.devPort);
        if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
          setError("devPort moet een geldig poortnummer zijn (1–65535).");
          setBusy(false);
          return;
        }
        payload.devPort = port;
      }
      if (form.devCommand.trim()) payload.devCommand = form.devCommand.trim();
      if (form.deployBranch.trim())
        payload.deployBranch = form.deployBranch.trim();

      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          hint?: string;
        };
        setError(messageFor(data.error, data.hint));
        setBusy(false);
        return;
      }
      setForm(EMPTY);
      setOpen(false);
      router.refresh();
    } catch {
      setError("Kon niet opslaan — netwerkfout.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-md border border-orange-700/60 bg-orange-900/40 px-3 py-1.5 text-sm text-orange-100 hover:bg-orange-900/60"
      >
        <Plus className="h-4 w-4" />
        <span>Nieuw project</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
          onClick={() => !busy && setOpen(false)}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={submit}
            className="w-full max-w-lg overflow-hidden rounded-t-xl border border-neutral-800 bg-neutral-950 shadow-2xl sm:rounded-xl"
          >
            <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
              <h2 className="text-base font-medium">Nieuw project</h2>
              <button
                type="button"
                onClick={() => !busy && setOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
                aria-label="Sluiten"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="max-h-[70vh] space-y-3 overflow-y-auto px-4 py-4">
              <Field label="Naam" required>
                <input
                  className={inputCls}
                  value={form.name}
                  onChange={(e) => onNameChange(e.target.value)}
                  placeholder="NEVA17 — Website"
                  autoFocus
                />
              </Field>
              <Field
                label="id"
                required
                hint="lowercase, cijfers, streepjes"
              >
                <input
                  className={inputCls}
                  value={form.id}
                  onChange={(e) => update("id", e.target.value)}
                  placeholder="neva17"
                />
              </Field>
              <Field
                label="Pad op schijf"
                hint="leeg laten = nieuwe map aanmaken in projects-root"
              >
                <input
                  className={inputCls}
                  value={form.path}
                  onChange={(e) => update("path", e.target.value)}
                  placeholder="C:/Users/santi/projects/… (optioneel)"
                />
              </Field>
              <Field label="Zichtbaarheid" required>
                <select
                  className={inputCls}
                  value={form.visibility}
                  onChange={(e) =>
                    update("visibility", e.target.value as Visibility)
                  }
                >
                  <option value="team">team</option>
                  <option value="client">client</option>
                  <option value="public">public</option>
                </select>
              </Field>

              <details className="rounded border border-neutral-800/80 px-3 py-2">
                <summary className="cursor-pointer text-xs text-neutral-400">
                  Meer opties (preview-URL, dev-poort, …)
                </summary>
                <div className="mt-3 space-y-3">
                  <Field label="subPath" hint="submap voor gedeelde repos">
                    <input
                      className={inputCls}
                      value={form.subPath}
                      onChange={(e) => update("subPath", e.target.value)}
                      placeholder="Woonklasse"
                    />
                  </Field>
                  <Field label="previewUrl">
                    <input
                      className={inputCls}
                      value={form.previewUrl}
                      onChange={(e) => update("previewUrl", e.target.value)}
                      placeholder="https://project.amaso.nl"
                    />
                  </Field>
                  <Field label="devPort">
                    <input
                      type="number"
                      className={inputCls}
                      value={form.devPort}
                      onChange={(e) => update("devPort", e.target.value)}
                      placeholder="1722"
                    />
                  </Field>
                  <Field label="devCommand">
                    <input
                      className={inputCls}
                      value={form.devCommand}
                      onChange={(e) => update("devCommand", e.target.value)}
                      placeholder="npx next dev --port {{PORT}}"
                    />
                  </Field>
                  <Field label="liveUrl">
                    <input
                      className={inputCls}
                      value={form.liveUrl}
                      onChange={(e) => update("liveUrl", e.target.value)}
                      placeholder="https://project.vercel.app"
                    />
                  </Field>
                  <Field label="deployBranch">
                    <input
                      className={inputCls}
                      value={form.deployBranch}
                      onChange={(e) => update("deployBranch", e.target.value)}
                      placeholder="main"
                    />
                  </Field>
                </div>
              </details>

              {error && (
                <p className="rounded border border-red-700/60 bg-red-900/40 px-3 py-2 text-xs text-red-100">
                  {error}
                </p>
              )}
            </div>

            <footer className="flex items-center justify-end gap-2 border-t border-neutral-800 px-4 py-3">
              <button
                type="button"
                onClick={() => !busy && setOpen(false)}
                className="rounded-md px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-900"
              >
                Annuleren
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-md border border-orange-700/60 bg-orange-900/60 px-3 py-1.5 text-sm text-orange-100 hover:bg-orange-800/60 disabled:opacity-50"
              >
                {busy ? "Bezig…" : "Project aanmaken"}
              </button>
            </footer>
          </form>
        </div>
      )}
    </>
  );
}

const inputCls =
  "w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none";

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="flex items-baseline gap-2 text-xs text-neutral-400">
        <span>
          {label}
          {required && <span className="ml-0.5 text-red-400">*</span>}
        </span>
        {hint && <span className="text-[10px] text-neutral-600">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function messageFor(error: string | undefined, hint: string | undefined) {
  switch (error) {
    case "invalid_id":
      return `id ongeldig${hint ? ` — ${hint}` : ""}`;
    case "duplicate_id":
      return "Er bestaat al een project met deze id.";
    case "missing_name":
      return "Naam is verplicht.";
    case "path_not_found":
      return "Pad bestaat niet op schijf.";
    case "path_not_directory":
      return "Pad is geen map.";
    case "auto_path_exists":
      return "Er bestaat al een map met die id in de projects-root — kies een andere id of vul handmatig een pad in.";
    case "mkdir_failed":
      return "Kon de nieuwe map niet aanmaken — check serverlog.";
    case "invalid_visibility":
      return "Zichtbaarheid ongeldig.";
    case "write_failed":
      return "Schrijffout bij config — check serverlog.";
    default:
      return "Kon project niet aanmaken.";
  }
}
