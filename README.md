# Equip

Equip manages AI agent skills and global instructions across your development computers. Choose skills in the dashboard, connect each computer once, and the background service installs the same selected revisions into detected agent profiles.

Discovery and agent compatibility build on [Vercel Skills](https://github.com/vercel-labs/skills). Equip adds accounts, custom skill publishing, updates and rollback, local change review, and device receipts. Skills live in a canonical local store with agent symlinks wherever supported. Offline computers catch up when they reconnect; local edits require a decision before replacement.

## Connect a computer

Create an account on your Equip instance, choose skills, then open **Connect computer** and copy its installation command. The macOS/Linux shell installer and Windows PowerShell installer install the CLI, runtime when needed, and background service, then start authorization.

Press Enter to open the browser and approve the computer. Headless connections show a URL and device code. Once installed:

```sh
equip connect
equip connect --headless
equip status
equip sync
```

Use the dashboard to inspect installation results, resolve local changes, publish instructions, and disconnect a computer with a choice to retain or remove managed files. Private repository credentials stay on each computer.

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
