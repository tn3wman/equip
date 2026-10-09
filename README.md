# Equip

Equip manages AI agent skills and global instructions across your development computers. Choose skills in the dashboard, connect each computer once, and the background service installs the same selected revisions into detected agent profiles.

Signed-out visitors see an overview page first; **Explore the demo** opens the read-only sample workspace, and the dashboard brand link returns to the overview. The dashboard offers light, dark, and system themes and a ⌘K command palette.

Discovery and agent compatibility build on [Vercel Skills](https://github.com/vercel-labs/skills). Equip adds accounts, custom skill publishing, updates and rollback, local change review, and device receipts. Skills live in a canonical local store with agent symlinks wherever supported. Offline computers catch up when they reconnect; local edits require a decision before replacement. Idle workers check every 60–120 seconds, and visible dashboards check every 30 seconds. Unchanged checks read only version fields; skill content transfers when needed.

## Connect a computer

Create an account on your Equip instance, choose skills, then open **Connect computer** and copy its installation command. The macOS/Linux shell installer and Windows PowerShell installer install the CLI, runtime when needed, and background service, then start authorization. The background worker starts at boot on Windows and Linux when the system permits it (a boot-time scheduled task on Windows, user lingering on Linux) and otherwise at logon. When Windows runs the worker as a boot-time task, it can't use credentials Windows protects with your password, such as Git Credential Manager logins, so private sources resolve on another connected computer or when you run `equip sync` while logged on.

Press Enter to open the browser and approve the computer. Headless connections show a URL and device code. Once installed:

```sh
equip connect
equip connect --headless
equip status
equip sync
```

Use the dashboard to inspect installation results, resolve local changes, publish instructions, and disconnect a computer with a choice to retain or remove managed files. Private repository credentials stay on each computer.

When local publishing is enabled, editing a managed global instruction file publishes it to your other computers. Conflicting local versions stay preserved for review.

Use `equip local remove <skill-name>` on a connected computer to delete a skill from Equip. Automatic sync removes unchanged managed installations on other computers as they reconnect. Edited and preexisting files remain preserved for review. This explicit command also works when automatic local publishing is disabled.

If a CLI update fails, `equip status` reports `lastUpdateError`. Skills continue syncing with the installed CLI.

`equip status` reports conflicted destinations in `lastError` and keeps `lastSync` at the last complete sweep. `equip sync` exits nonzero when any destination fails or conflicts.

## Develop locally

Requires Node.js 22.20 or newer and npm.

```sh
npm ci
npm run build:cli
npm run dev
```

Open http://127.0.0.1:5173. The API listens on port 4310 and defaults to SQLite in the ignored `.equip-data` directory. Use a fresh `EQUIP_DATA_DIR` when testing against an existing checkout. The dashboard provides the local connection command.

```sh
npm test
npm run typecheck
npm run build
```

## Hosting and boundaries

The hosted setup uses Vercel for the dashboard, Railway for the API, Supabase PostgreSQL for persistence, and Resend for email. The Vercel build requires `EQUIP_API_URL` pointing to the API's HTTPS origin. The API uses `EQUIP_DATABASE_URL` for PostgreSQL and `EQUIP_PUBLIC_URL` for its public dashboard origin. Production CLI releases require `EQUIP_RELEASE_PRIVATE_KEY` matching the public key pinned in [cli/update.ts](cli/update.ts); self-hosted releases need their own signing key and corresponding CLI trust key. Configure secrets in your hosting environment; keep credentials and local data out of Git.

Vercel deployments from `main` are disabled for now; preview branches remain enabled. The existing hosted preview is restricted to personal access. A public repository does not make that instance a public registration service.

Connecting a computer installs into local agent destinations. Separately hosted agent sessions and account skill libraries require their supported import or publishing mechanism; unavailable integrations and native instruction limits are shown explicitly. Account uploads remain manual where no supported publishing API exists.
