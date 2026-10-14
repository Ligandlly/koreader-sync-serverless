# KOReader Sync

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=Cloudflare&logoColor=white" />
  <img src="https://img.shields.io/badge/Cloudflare-D1-F38020?style=for-the-badge&logo=Cloudflare&logoColor=white" />
  <img src="https://img.shields.io/badge/Alibaba_Cloud-Function_Compute-FF6A00?style=for-the-badge&logo=alibabacloud&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" />
</p>

A KOReader sync service with decoupled runtime/data adapters, currently supporting:
- **Cloudflare Worker + D1**
- **Aliyun Function Compute + NAS (SQLite)**
- **Local production (Node + SQLite)**

Includes:
- KOReader-compatible sync APIs (register, auth, progress upload/fetch)
- Admin Web UI for user management (delete user, force reset password)
- User Web UI for personal login and statistics/records

![User Web UI 1](https://github.com/user-attachments/assets/f38570a1-4421-42bc-a524-2e624cab1ca5)
![User Web UI 2](https://github.com/user-attachments/assets/cea579c4-ee79-4db4-a173-e190855b033a)


You can also check out [this site](https://ksync.api.tski.uk/) (Cloudflare Worker + D1) to see how it works.

## How to use

For example, I use public server at `https://ksync.api.tski.uk/`.

1. Download and install [this repo](https://github.com/Tokisaki-Galaxy/koreader-kosync2.kolpugin) to your KOReader device
2. Click the settings icon and configure the plugin, set the server URL to `https://ksync.api.tski.uk/`.
3. Click the register button to create a new account, or log in with your existing credentials.
4. If you want to use the web dashboard, visit `https://ksync.api.tski.uk/` in your browser and log in with your KOReader credentials.

## Deployment

### Cloudflare: web

Click the button below to deploy your own instance of KOReader Sync directly to Cloudflare Workers:

[![deploy](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tokisaki-galaxy/koreader-sync-serverless)

- Configure Secrets: Once deployed successfully, go to your Cloudflare Worker dashboard -> Settings -> Variables.
Add Secrets: Add `PASSWORD_PEPPER` and `ADMIN_TOKEN` as encrypted secrets.

- Redeploy: Trigger a redeploy for the secrets to take effect.

- Initialize Database: Visit your Worker URL at /admin, log in with your ADMIN_TOKEN, and click the Initialize Database button to create the required tables.

### Cloudflare: CLI

1. Set production secrets:

```bash
npx wrangler secret put PASSWORD_PEPPER
npx wrangler secret put ADMIN_TOKEN
```

2. Apply remote migrations:

```bash
npx wrangler d1 migrations apply koreader-sync-db --remote
```

> If migrations are skipped, admins can initialize required tables from `/admin` after login.

3. Deploy Worker:

```bash
npm run deploy
```

### Docker (Production-like Local Runtime)

Docker now runs the **Node local-production runtime** (not `wrangler dev`):

1. Build image:

```bash
docker build -t koreader-sync:prod-local .
```

2. Run container:

```bash
docker run --rm -p 8787:8787 \
  -e RUNTIME_TARGET=node \
  -e DB_DRIVER=sqlite \
  -e SQLITE_PATH=/app/data/koreader-sync.db \
  -e PASSWORD_PEPPER=your-strong-secret \
  -e ADMIN_TOKEN=your-admin-token \
  -v $(pwd)/data:/app/data \
  koreader-sync:prod-local
```

3. Visit:

- Health check: `http://localhost:8787/healthcheck`
- User page: `http://localhost:8787/`
- Admin page: `http://localhost:8787/admin`

### Aliyun Function Compute (Serverless)

Runs the same Hono app on **Aliyun Function Compute 3.0** (`nodejs20` runtime)
behind an anonymous HTTP trigger. Because FC's built-in Node.js runtime has no
`node:sqlite`, SQLite is provided by `sql.js` (WebAssembly) and the database file
is persisted on an **NFS NAS** mount (`/mnt/data`). Writes are guarded by a
cross-process lock and each read re-syncs when the file changes, so the service
stays correct even if FC scales beyond one instance.

Implementation lives in `src/fc/`:

- `src/fc/index.ts` — FC HTTP event ⇄ Fetch API adapter (reuses the Hono app) and
  automatic migration runner.
- `src/fc/sqljsAdapter.ts` — `sql.js` implementation of the `DatabaseAdapter`
  interface with lock + reload + atomic rename persistence.

Prerequisites: the `aliyun` CLI configured with credentials, plus `node`, `zip`
and `python3` on PATH.

1. Install dependencies (also installs `esbuild`):

```bash
npm install
```

2. Provision the VPC/NAS resources once (idempotent). This also creates
`deploy/aliyun/.env` with generated `PASSWORD_PEPPER` / `ADMIN_TOKEN` secrets:

```bash
npm run provision:aliyun
```

3. Build and deploy the function + HTTP trigger:

```bash
npm run deploy:aliyun
```

Both scripts can be re-run safely. `deploy:aliyun` bundles `src/fc/index.ts`
with esbuild (`scripts/build-fc.mjs`), uploads the code package inline and
creates or updates the function together with its VPC/NAS config and HTTP
trigger.

The command prints the public URL. Then:

- Health check: `<url>/healthcheck`
- User page: `<url>/`
- Admin page: `<url>/admin` (log in with `ADMIN_TOKEN` from `deploy/aliyun/.env`)

Database tables are created automatically on the first cold start (all files in
`migrations/` are applied in order). To ship an update, re-run
`npm run deploy:aliyun`; the function and code are updated in place.

#### Listing users

`scripts/list-users.sh` (also `npm run users`) logs in with `ADMIN_TOKEN` and
prints the registered users. It resolves the base URL and token from
`deploy/aliyun/.env`, or you can point it anywhere:

```bash
npm run users                       # auto-detect the FC trigger URL
npm run users -- --json             # raw JSON response
npm run users -- --url http://localhost:8787 --token mytoken
npm run users -- --local --token mytoken
```

Deployment settings (region, function name, secrets, discovered VPC/NAS ids) live
in `deploy/aliyun/.env`, which is git-ignored. See
`deploy/aliyun/.env.example` for the available keys.

#### Known limitation: the default domain forces downloads

Aliyun forces `Content-Disposition: attachment` on **every** response served
through the default `*.fcapp.run` domain. This is applied by the gateway, not by
the function: returning `Content-Disposition: inline` from the handler does not
override it, and it happens for plain HTTP functions as well as for Custom
Runtime Web functions. As a result, opening `<url>/` in a browser downloads the
HTML file instead of rendering it. This only affects the browser UI — the
KOReader sync API ignores the header and works normally.

To serve the web UI in a browser you need a custom domain (自定义域名), because
responses served through a custom domain are not given the forced header:

1. Add a `CNAME` record for your domain pointing to the target shown in the
   Function Compute console (函数 → `koreader-sync` → 自定义域名).
2. Bind the domain to the function:

   ```bash
   aliyun fc CreateCustomDomain --region cn-hangzhou --body '{
     "domainName": "ksync.example.com",
     "protocol": "HTTP",
     "routeConfig": { "routes": [{
       "path": "/*",
       "functionName": "koreader-sync",
       "qualifier": "LATEST",
       "methods": ["GET","POST","PUT","DELETE","PATCH","HEAD","OPTIONS"]
     }]}
   }'
   ```

   For HTTPS, add a `certConfig` (or request a free certificate from the
   console). Domains bound to mainland China regions require an ICP filing (备案);
   functions deployed in `cn-hongkong` or overseas regions do not.

Without a domain, the remaining option is to place a small reverse proxy in
front of the FC URL that strips the `Content-Disposition` header.

## Architecture

- Runtime targets:
  - `cloudflare` (implemented)
  - `node` (implemented for local production)
  - `vercel` (reserved interface, not implemented yet)
  - Aliyun Function Compute 3.0 (implemented via `src/fc/`, built on the `node`
    runtime target, `nodejs20` runtime with sql.js on NAS)
- Database drivers:
  - `d1` (Cloudflare runtime)
  - `sqlite` (Node runtime)
  - `postgres` (reserved interface, not implemented yet)
- Web UIs served directly by the app:
  - `/`: user dashboard
  - `/admin`: admin console

## API Overview

### KOReader-Compatible Endpoints

- `POST /users/create` register user
- `GET /users/auth` authenticate (`x-auth-user` + `x-auth-key`)
- `PUT /syncs/progress` upload progress
- `GET /syncs/progress/:document` fetch progress by document
- `PUT /syncs/statistics` synchronize reading statistics snapshot

> KOReader sends `x-auth-key` as `md5(plain_password)`. This service stores/verifies KOReader credentials against that value for protocol compatibility. MD5 is weak by itself; here it is only a protocol input and is still wrapped by server-side PBKDF2 hashing before storage.

> `POST /users/create` accepts either the KOReader md5 key (what the device sends) or the plain password; both are normalized to the md5 form before hashing. Accounts created before this normalization stored a double hash (`md5(md5(plain))`); a compatibility fallback in the auth/web-login paths keeps those accounts working.

> `PUT /syncs/statistics` additionally requires the KOReader client headers
> `x-client-version: y-anna-*` and `user-agent: Mozilla/DONTLIKE/ANYTHING`;
> otherwise the endpoint returns `404 Not Found`.

### User Web Dashboard Endpoints

- `POST /web/auth/login` login (sets HttpOnly cookie)
- `POST /web/auth/logout` logout
- `GET /web/me` current user
- `GET /web/records?page=1&pageSize=20` reading records
- `GET /web/stats` statistics summary
- `GET /web/statistics/books` synchronized books statistics list
- `GET /web/export/db-format` SQLite schema SQL for the client-side exporter
- `GET /web/export/data` full export payload for the current user (progress + statistics snapshot)
- `POST /web/import` restore progress/statistics parsed from an exported `.db` file
- `GET /` user dashboard page

### Data Export / Import (User Web UI)

The user dashboard includes an "Export / Import Data" section after login:

- **Export** downloads two real SQLite files, generated **client-side** (via `sql.js` served from the service at `/assets/sql-wasm.js` + `/assets/sql-wasm.wasm`, embedded as base64 constants so no external CDN or build-time module rules are needed, and the Worker stays within the free-tier CPU budget):
  - `statistics.sqlite3` — official KOReader reading-statistics schema (`book` + `page_stat_data` + `page_stat` view, `PRAGMA user_version=20221111`), readable directly by KOReader devices/tools.
  - `progress.db` — custom progress schema (`users` + `progress`). Note: official KOReader stores progress per-book in `.sdr/metadata.lua` (not a database), so there is no official progress DB format to match; this is our defined backup format.
- **Import** restores either file type (auto-detected by its tables) into the current user's account, merging with existing data (statistics are merged by book `md5`).


### Reading Statistics Sync Contract

`PUT /syncs/statistics` request body:

```json
{
  "schema_version": 20221111,
  "device": "KOReader Device Model",
  "device_id": "device-id-or-empty-string",
  "snapshot": {
    "books": [
      {
        "md5": "partial-md5",
        "title": "Book title",
        "authors": "Author",
        "notes": 0,
        "last_open": 1710000000,
        "highlights": 0,
        "pages": 320,
        "series": "Series #1",
        "language": "en",
        "total_read_time": 1234,
        "total_read_pages": 88,
        "page_stat_data": [
          {
            "page": 12,
            "start_time": 1710000100,
            "duration": 24,
            "total_pages": 320
          }
        ]
      }
    ]
  }
}
```

Notes:
- Auth is identical to other KOReader sync endpoints (`x-auth-user`, `x-auth-key`).
- Server uses `md5` as cross-device identity key for merge.
- `page_stat_data[].start_time` comes from the device clock. Entries more than 6 hours in the future are treated as a bad clock and left out of every reading statistic: daily totals, per-book days, streaks, hourly chart and trajectory. The raw snapshot is kept as-is so exports stay faithful.
- Response format:

```json
{
  "ok": true,
  "snapshot": {
    "books": []
  }
}
```

### Admin Web Endpoints (Token Auth)

- `POST /admin/auth/login` admin login with `{ "token": "..." }`
- `POST /admin/auth/logout` admin logout
- `GET /admin/me` current admin session status
- `GET /admin/init/status` check whether required tables exist
- `POST /admin/init` initialize required database tables and indexes
- `GET /admin/users` list users
- `DELETE /admin/users/:id` delete user
- `PUT /admin/users/:id/password` force reset user password
- `GET /admin` admin dashboard page

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Configure local vars:

```bash
cp .dev.vars.example .dev.vars
# Update PASSWORD_PEPPER with a strong random value
# Set ADMIN_TOKEN for admin console login
```

3. Create D1 database and update `wrangler.toml`:

```bash
npx wrangler d1 create koreader-sync-db
# Put returned database_id into wrangler.toml
```

4. Apply migrations:

```bash
npx wrangler d1 migrations apply koreader-sync-db --local
```

> You can also login to `/admin` first and use the “Initialize database” button when required tables are missing.

5. Start dev server:

```bash
npm run dev
```

## Local Production (Node + SQLite)

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
# set PASSWORD_PEPPER and ADMIN_TOKEN
# then set:
# RUNTIME_TARGET=node
# DB_DRIVER=sqlite
# SQLITE_PATH=./data/koreader-sync.db
```

3. Run:

```bash
npm run start:local-prod
```

4. Endpoints:

- Health check: `http://localhost:8787/healthcheck`
- User page: `http://localhost:8787/`
- Admin page: `http://localhost:8787/admin`

## npm Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Run the Cloudflare Worker dev server (`wrangler dev`) |
| `npm run deploy` | Deploy to Cloudflare Workers (`wrangler deploy`) |
| `npm run start:local-prod` | Run the local Node + SQLite runtime |
| `npm run typecheck` / `npm run check` | TypeScript type check |
| `npm test` | Run the test suite (vitest) |
| `npm run build:aliyun` | Build the Aliyun FC bundle into `dist-fc/` |
| `npm run provision:aliyun` | Create/discover the VPC + NAS resources for FC |
| `npm run deploy:aliyun` | Build + create/update the FC function and HTTP trigger |
| `npm run users` | List registered users via the admin API (`npm run users -- --local`, `--json`, `--url <base>`) |

## Security Notes

- Password hashing uses PBKDF2-SHA256 with high iteration count
- Web session cookie: `HttpOnly + Secure + SameSite=Lax`
- Session token is stored hashed in database
- All SQL uses bound parameters

## Runtime Configuration

REQUIRED environment variables:
- `PASSWORD_PEPPER`: required strong secret for password/session hashing
- `ADMIN_TOKEN`: required for admin web login
- `SESSION_TTL_HOURS`: optional session lifetime in hours, default `168`
- `SESSION_RENEW_WINDOW_HOURS`: optional sliding-session renewal window in hours, default is half of `SESSION_TTL_HOURS`. When an authenticated request arrives with at most this much lifetime left, the session is extended back to a full TTL. Set `0` to disable renewal, or the full TTL to renew on every request.
Runtime / database selector:
- `RUNTIME_TARGET`: `cloudflare` (default) or `node`; `vercel` is reserved but not implemented. Aliyun Function Compute uses the `node` target through `src/fc/`.
- `DB_DRIVER`: `d1` (default) or `sqlite`; `postgres` is reserved but not implemented
- `SQLITE_PATH`: sqlite db path for `RUNTIME_TARGET=node` + `DB_DRIVER=sqlite` (on Aliyun FC this points at the NAS mount, e.g. `/mnt/data/koreader-sync.db`)
OPTIONAL environment variables:
- `DEBUG`: optional (`"1"`/`"true"` enables debug error logs)
- `PBKDF2_ITERATIONS`: optional number of iterations for PBKDF2 hashing, default `20000` (adjust based on your performance/security needs)
- `ENABLE_USER_REGISTRATION`: optional (`"1"`/`"true"` to allow user self-registration, default is open registration)

## Aliyun Deployment Files

| Path | Description |
| --- | --- |
| `src/fc/index.ts` | FC HTTP handler / Fetch API adapter + migration bootstrap |
| `src/fc/sqljsAdapter.ts` | `sql.js`-backed SQLite adapter with NAS persistence |
| `scripts/build-fc.mjs` | esbuild bundler for the FC code package |
| `scripts/provision-aliyun.sh` | One-time VPC/NAS provisioning (idempotent) |
| `scripts/deploy-aliyun.sh` | Build + create/update FC function and HTTP trigger |
| `scripts/list-users.sh` | List registered users (admin API; auto-detects the FC URL) |
| `deploy/aliyun/.env.example` | Deployment configuration template |
| `deploy/aliyun/.env` | Generated secrets + discovered resource ids (git-ignored) |
