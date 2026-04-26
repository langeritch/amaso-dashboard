# Amaso Dashboard

Live web view of projects running on this machine. The dashboard is served from your PC and exposed at `dashboard.amaso.nl` via a Cloudflare Tunnel.

```
Browser ─── WSS ───▶ Cloudflare Edge ◀── outbound tunnel ── Next.js server on your PC
                                                              ├─ chokidar file watcher
                                                              └─ SQLite (users, remarks)
```

When your PC is off, the tunnel drops and the site is offline — by design.

## Stack

- Next.js 16 (App Router) + React 19 + Tailwind 4
- Custom server in `server.ts` that hosts Next.js AND a WebSocket endpoint (`/api/sync`)
- `chokidar` watches configured project directories; events push over WS
- `better-sqlite3` for users, sessions, and remarks
- `@monaco-editor/react` for the read-only code viewer with gutter remarks
- `diff` + in-memory snapshot ring buffer for the recent-changes view
- `cloudflared` tunnels `http://localhost:3737` → `dashboard.amaso.nl`

## What's in the box

| Feature | Status |
|---|---|
| Live file tree + content | ✅ |
| Monaco viewer with syntax highlighting | ✅ |
| Password auth (local DB) with HMAC-signed session cookies | ✅ |
| Roles: `admin`, `team`, `client` | ✅ |
| Per-project access grants for `client` users | ✅ |
| Admin user-management UI (`/admin/users`) | ✅ |
| CLI fallback (`scripts/user.mjs`) for bootstrap + rescue | ✅ |
| Per-file / per-line remarks with Monaco gutter markers | ✅ |
| Recent-changes feed with unified-diff view | ✅ |
| Cloudflare Tunnel setup + Windows auto-start tasks | ✅ |

## First-time setup

```powershell
cd C:\Users\santi\projects\amaso-dashboard
npm install

# Add your projects to amaso.config.json, then:
npm run dev
# visit http://localhost:3737 → /setup will ask you to create the first admin
```

## Going live

```powershell
# One-time: create the Cloudflare Tunnel and DNS record
scripts\setup-tunnel.ps1

# Build
npm run build

# Install auto-start tasks (runs app + tunnel at login)
scripts\install-service.ps1
Start-ScheduledTask -TaskName AmasoDashboard-App
Start-ScheduledTask -TaskName AmasoDashboard-Tunnel
```

## Configuration — `amaso.config.json`

```json
{
  "projects": [
    {
      "id": "client-x",
      "name": "Client X Website",
      "path": "C:/Users/santi/projects/client-x",
      "visibility": "team"
    }
  ],
  "ignore": ["node_modules/**", ".next/**", ".git/**"]
}
```

Adding or removing entries requires a server restart (`Restart-ScheduledTask AmasoDashboard-App`). Changes to files inside a watched project are picked up live.

## User CLI — `scripts/user.mjs`

Useful when the web UI isn't reachable (fresh install, locked-out admin):

```powershell
node scripts/user.mjs list
node scripts/user.mjs create <email> <name> <role> [password]   # role = admin | team | client
node scripts/user.mjs reset  <email> [password]
node scripts/user.mjs delete <email>
```

If `<password>` is omitted, a random one is generated and printed.

## Auth model

- First visit with no users in the DB redirects to `/setup`, where you create the admin.
- Subsequent visits require a session cookie. Cookies are `httpOnly`, `sameSite=lax`, `secure` in production, HMAC-signed with a per-install secret (`data/.session-secret`).
- `admin` and `team` see all projects. `client` sees only the projects you grant them in `/admin/users`.
- WebSocket upgrades are authenticated by the same cookie; unauthenticated upgrades return `401`.
- Remark deletion: only the author or an admin.

## Data storage

Everything lives under `data/`:
- `amaso.db` — SQLite file (users, sessions, project_access, remarks)
- `.session-secret` — 32-byte HMAC secret (mode 0600)

Back up `data/` and you've backed up the dashboard.

## Roadmap

- [ ] Client self-signup links (invite tokens)
- [ ] Email notifications on new remarks
- [ ] Per-project dashboards with deploy / build metadata
- [ ] Full-text search across files
