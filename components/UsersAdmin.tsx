"use client";

import { useEffect, useState } from "react";
import { Trash2, Plus, KeyRound } from "lucide-react";

type Role = "admin" | "team" | "client";
interface UserRow {
  id: number;
  email: string;
  name: string;
  role: Role;
  projects: string[];
  created_at: number;
}

export default function UsersAdmin({
  projects,
  currentUserId,
}: {
  projects: { id: string; name: string }[];
  currentUserId: number;
}) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  async function refresh() {
    const res = await fetch("/api/admin/users", { cache: "no-store" });
    const body = await res.json();
    setUsers(body.users);
    setLoading(false);
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function remove(id: number) {
    if (!confirm("Delete this user?")) return;
    await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
    await refresh();
  }

  async function patch(id: number, body: Partial<UserRow> & { password?: string; projects?: string[] }) {
    await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="amaso-fx amaso-press flex min-h-[40px] items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900/70 px-3 py-1.5 text-sm hover:border-neutral-700 hover:bg-neutral-800/70 sm:min-h-0"
        >
          <Plus className="h-3.5 w-3.5" /> New user
        </button>
      </div>

      {creating && (
        <CreateUserForm
          projects={projects}
          onCreated={async () => {
            setCreating(false);
            await refresh();
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {loading ? (
        <ul className="divide-y divide-neutral-800/70 overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/30 shadow-[0_1px_2px_rgba(0,0,0,0.2)]">
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="amaso-fade-in flex items-center gap-3 p-4"
              style={{ animationDelay: `${i * 50}ms` }}
            >
              <div className="min-w-0 flex-1 space-y-2">
                <div className="amaso-skeleton h-3 w-1/3" />
                <div className="amaso-skeleton h-2.5 w-2/3" />
              </div>
              <div className="amaso-skeleton h-5 w-14 rounded-full" />
            </li>
          ))}
        </ul>
      ) : users.length === 0 ? (
        <div className="amaso-fade-in-slow flex flex-col items-center rounded-xl border border-dashed border-neutral-800 bg-neutral-900/30 px-6 py-10 text-center">
          <p className="text-sm font-medium text-neutral-300">No users yet</p>
          <p className="mt-1 max-w-sm text-xs leading-relaxed text-neutral-500">
            Tap <span className="text-neutral-300">New user</span> above to
            create the first one.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-neutral-800/70 overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/30 shadow-[0_1px_2px_rgba(0,0,0,0.2)]">
          {users.map((u, idx) => (
            <li
              key={u.id}
              className="amaso-fade-in p-4"
              style={{ animationDelay: `${Math.min(idx, 8) * 35}ms` }}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-neutral-100">{u.name}</span>
                    <RoleBadge role={u.role} />
                    {u.role === "client" && u.projects.length > 0 && (
                      <span className="text-[11px] text-neutral-500">
                        · {u.projects.length} project
                        {u.projects.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-neutral-500">{u.email}</p>
                </div>
                <button
                  type="button"
                  onClick={() => remove(u.id)}
                  disabled={u.id === currentUserId}
                  title={u.id === currentUserId ? "Can't delete yourself" : "Delete"}
                  className="text-neutral-500 hover:text-rose-300 disabled:opacity-30"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <label className="text-neutral-500">Role:</label>
                <select
                  value={u.role}
                  onChange={(e) => patch(u.id, { role: e.target.value as Role })}
                  className="amaso-fx rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-1 hover:border-neutral-700"
                >
                  <option value="admin">admin</option>
                  <option value="team">team</option>
                  <option value="client">client</option>
                </select>
                <PasswordChange
                  disabled={u.id === currentUserId}
                  onSave={(password) => patch(u.id, { password })}
                />
              </div>
              {u.role === "client" && (
                <div className="mt-3">
                  <p className="mb-1.5 text-xs text-neutral-500">
                    Project access:
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {projects.map((p) => {
                      const enabled = u.projects.includes(p.id);
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            const next = enabled
                              ? u.projects.filter((x) => x !== p.id)
                              : [...u.projects, p.id];
                            patch(u.id, { projects: next });
                          }}
                          className={`amaso-fx rounded-full border px-2.5 py-0.5 text-xs ${
                            enabled
                              ? "border-orange-500/40 bg-orange-500/15 text-orange-200 shadow-[0_0_0_1px_rgba(255,107,61,0.15)]"
                              : "border-neutral-800 text-neutral-500 hover:border-neutral-700 hover:text-neutral-300"
                          }`}
                        >
                          {p.name}
                        </button>
                      );
                    })}
                    {projects.length === 0 && (
                      <span className="text-xs text-neutral-600">
                        (no projects configured yet)
                      </span>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RoleBadge({ role }: { role: Role }) {
  // Distinct color per role so admins / team / clients are scannable at
  // a glance instead of squinting at small grey text.
  if (role === "admin") {
    return (
      <span className="inline-flex items-center rounded-full border border-orange-500/40 bg-orange-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-orange-200">
        Admin
      </span>
    );
  }
  if (role === "team") {
    return (
      <span className="inline-flex items-center rounded-full border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-sky-200">
        Team
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-lime-400/40 bg-lime-400/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-lime-200">
      Client
    </span>
  );
}

function CreateUserForm({
  projects,
  onCreated,
  onCancel,
}: {
  projects: { id: string; name: string }[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("team");
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setPending(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          password,
          role,
          projects: role === "client" ? selectedProjects : undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(
          body.error === "email_taken"
            ? "Email already in use."
            : body.error === "password_too_short"
              ? "Password must be at least 8 characters."
              : "Failed to create user.",
        );
        return;
      }
      onCreated();
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-xl border border-neutral-800/80 bg-neutral-900/50 p-4 shadow-[0_1px_2px_rgba(0,0,0,0.2)]"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-xs">
          <span className="mb-1 block text-neutral-400">Name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="min-h-[40px] w-full rounded-md border border-neutral-800 bg-neutral-900/60 px-2.5 py-1.5 text-base outline-none transition-[border-color,box-shadow] duration-200 ease-out focus:border-orange-500/50 focus:shadow-[0_0_0_3px_rgba(255,107,61,0.12)] sm:min-h-0 sm:text-sm"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-neutral-400">Email</span>
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="min-h-[40px] w-full rounded-md border border-neutral-800 bg-neutral-900/60 px-2.5 py-1.5 text-base outline-none transition-[border-color,box-shadow] duration-200 ease-out focus:border-orange-500/50 focus:shadow-[0_0_0_3px_rgba(255,107,61,0.12)] sm:min-h-0 sm:text-sm"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-neutral-400">Password</span>
          <input
            required
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            className="min-h-[40px] w-full rounded-md border border-neutral-800 bg-neutral-900/60 px-2.5 py-1.5 text-base outline-none transition-[border-color,box-shadow] duration-200 ease-out focus:border-orange-500/50 focus:shadow-[0_0_0_3px_rgba(255,107,61,0.12)] sm:min-h-0 sm:text-sm"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-neutral-400">Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="min-h-[40px] w-full rounded-md border border-neutral-800 bg-neutral-900/60 px-2.5 py-1.5 text-base outline-none transition-[border-color,box-shadow] duration-200 ease-out focus:border-orange-500/50 focus:shadow-[0_0_0_3px_rgba(255,107,61,0.12)] sm:min-h-0 sm:text-sm"
          >
            <option value="team">team</option>
            <option value="client">client</option>
            <option value="admin">admin</option>
          </select>
        </label>
      </div>
      {role === "client" && (
        <div>
          <p className="mb-1.5 text-xs text-neutral-400">Project access:</p>
          <div className="flex flex-wrap gap-1.5">
            {projects.map((p) => {
              const enabled = selectedProjects.includes(p.id);
              return (
                <button
                  type="button"
                  key={p.id}
                  onClick={() =>
                    setSelectedProjects((cur) =>
                      enabled
                        ? cur.filter((x) => x !== p.id)
                        : [...cur, p.id],
                    )
                  }
                  className={`amaso-fx rounded-full border px-2.5 py-0.5 text-xs ${
                    enabled
                      ? "border-orange-500/40 bg-orange-500/15 text-orange-200 shadow-[0_0_0_1px_rgba(255,107,61,0.15)]"
                      : "border-neutral-800 text-neutral-500 hover:border-neutral-700 hover:text-neutral-300"
                  }`}
                >
                  {p.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {err && <p className="text-sm text-rose-300">{err}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="amaso-fx amaso-press min-h-[40px] rounded-md border border-neutral-800 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-700 hover:text-neutral-100 sm:min-h-0"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending}
          className="amaso-fx amaso-press min-h-[40px] rounded-md bg-orange-500 px-4 py-1.5 text-sm font-semibold text-neutral-950 shadow-[0_2px_8px_rgba(255,107,61,0.3)] hover:bg-orange-400 disabled:bg-neutral-700 disabled:text-neutral-400 disabled:shadow-none sm:min-h-0"
        >
          {pending ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );
}

function PasswordChange({
  disabled,
  onSave,
}: {
  disabled: boolean;
  onSave: (password: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  async function save() {
    if (password.length < 8) {
      setErr("Min 8 characters.");
      return;
    }
    setErr(null);
    setSaving(true);
    try {
      await onSave(password);
      setPassword("");
      setOpen(false);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title={disabled ? "Can't change your own password here" : "Change password"}
        className={`flex items-center gap-1 rounded border px-2 py-1 transition disabled:opacity-30 ${
          justSaved
            ? "border-orange-700 bg-orange-900/30 text-orange-300"
            : "border-neutral-800 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200"
        }`}
      >
        <KeyRound className="h-3 w-3" />
        {justSaved ? "Updated" : "Change password"}
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input
        type="password"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            setOpen(false);
            setPassword("");
            setErr(null);
          }
        }}
        minLength={8}
        placeholder="New password…"
        className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs"
      />
      <button
        type="button"
        onClick={() => void save()}
        disabled={saving || password.length < 8}
        className="amaso-fx amaso-press rounded-md bg-orange-500 px-2.5 py-1 text-xs font-semibold text-neutral-950 hover:bg-orange-400 disabled:bg-neutral-700 disabled:text-neutral-400"
      >
        {saving ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setPassword("");
          setErr(null);
        }}
        className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:border-neutral-700"
      >
        Cancel
      </button>
      {err && <span className="text-xs text-rose-300">{err}</span>}
    </div>
  );
}
