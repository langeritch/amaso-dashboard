"use client";

import { useEffect, useState } from "react";
import { Trash2, Plus } from "lucide-react";

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
          className="flex min-h-[40px] items-center gap-1.5 rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm hover:border-neutral-700 sm:min-h-0"
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
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : users.length === 0 ? (
        <p className="text-sm text-neutral-500">No users yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-800 rounded border border-neutral-800">
          {users.map((u) => (
            <li key={u.id} className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{u.name}</span>
                    <span className="rounded-full border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400">
                      {u.role}
                    </span>
                  </div>
                  <p className="text-xs text-neutral-500">{u.email}</p>
                </div>
                <button
                  type="button"
                  onClick={() => remove(u.id)}
                  disabled={u.id === currentUserId}
                  title={u.id === currentUserId ? "Can't delete yourself" : "Delete"}
                  className="text-neutral-500 hover:text-red-400 disabled:opacity-30"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <label className="text-neutral-500">Role:</label>
                <select
                  value={u.role}
                  onChange={(e) => patch(u.id, { role: e.target.value as Role })}
                  className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1"
                >
                  <option value="admin">admin</option>
                  <option value="team">team</option>
                  <option value="client">client</option>
                </select>
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
                          className={`rounded-full border px-2 py-0.5 text-xs transition ${
                            enabled
                              ? "border-emerald-700 bg-emerald-900/30 text-emerald-300"
                              : "border-neutral-800 text-neutral-500 hover:border-neutral-700"
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
      className="space-y-3 rounded border border-neutral-800 bg-neutral-900/50 p-4"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-xs">
          <span className="mb-1 block text-neutral-400">Name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="min-h-[40px] w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-base sm:min-h-0 sm:text-sm"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-neutral-400">Email</span>
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="min-h-[40px] w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-base sm:min-h-0 sm:text-sm"
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
            className="min-h-[40px] w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-base sm:min-h-0 sm:text-sm"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-neutral-400">Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="min-h-[40px] w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-base sm:min-h-0 sm:text-sm"
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
                  className={`rounded-full border px-2 py-0.5 text-xs ${
                    enabled
                      ? "border-emerald-700 bg-emerald-900/30 text-emerald-300"
                      : "border-neutral-800 text-neutral-500 hover:border-neutral-700"
                  }`}
                >
                  {p.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {err && <p className="text-sm text-red-400">{err}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="min-h-[40px] rounded border border-neutral-800 px-3 py-1.5 text-sm text-neutral-300 sm:min-h-0"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending}
          className="min-h-[40px] rounded bg-white px-4 py-1.5 text-sm font-medium text-black disabled:opacity-50 sm:min-h-0"
        >
          {pending ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );
}
