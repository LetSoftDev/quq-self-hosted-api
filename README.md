# QuqManager Self-Hosted API

Self-hosted file manager API for QuqManager. This backend lets you keep uploaded files on your own server while using the QuqManager platform for project configuration, API keys, and frontend integrations.

Use it when you want QuqManager's embeddable file manager in your app, but need file storage and file-serving endpoints to run on infrastructure you control.

Learn more about the <a href="https://quq.letsoft.co/" target="_blank" rel="noopener noreferrer">QuqManager platform</a>.

## Requirements

- Linux server only. Windows Server is not supported.
- Recommended server OS: Ubuntu or Debian.
- Minimum for a small test server: 1 vCPU and 1 GB RAM.
- Recommended for production or Docker builds: 2 vCPU and 2 GB RAM or more.
- Disk size depends on uploaded files. Start with at least 20 GB SSD and grow `UPLOADS_DIR` storage as needed.
- Node.js 20.9+ and npm when running with PM2.
- Docker with Docker Compose when running containers.
- Nginx and Certbot only when exposing the API through HTTPS on your domain.

Docker image builds install native dependencies and can be slow on very small servers. If you use a 1 vCPU / 1 GB instance, expect the first build to take longer; 2 GB RAM or swap is strongly recommended.

The setup wizard detects the Linux distribution and checks these tools only at the step where they are needed. Automatic installation is supported for common Linux families: Debian/Ubuntu, RHEL-compatible distributions, Arch-based distributions, and Alpine where packages are available. Unknown Linux distributions fall back to manual instructions.

## Setup

```bash
chmod +x scripts/setup.sh
./scripts/setup.sh
```

The API starts on `http://localhost:3000` by default.

The setup wizard asks for the public runtime values, creates storage folders automatically, and lets you choose how the API should stay alive. `DATA_DIR` is always written as `./data`; you do not need to enter it manually. When the wizard asks for `VALIDATION_SECRET`, copy it from the <a href="https://quq.letsoft.co/" target="_blank" rel="noopener noreferrer">QuqManager dashboard</a>: `Projects -> select project -> Settings -> Validation Secret`.

The platform validation URL is built into the self-hosted API. You only configure your project `VALIDATION_SECRET`; there is no backend-pro URL environment variable.

The wizard writes the runtime configuration for you. If your deployment needs it, you can also set the same values manually instead of using the wizard: port, uploads directory, max file size, request timeout, node environment, and Validation Secret. The default upload size limit is 5 GB (`MAX_FILE_SIZE=5368709120`), and the default request timeout is 30 minutes (`REQUEST_TIMEOUT_MS=1800000`) for large uploads.

## Runtime wizard

Choose one runtime in `scripts/setup.sh`:

- `Docker Compose restart policy`: checks Docker and Compose, can install Docker on supported Linux distributions, builds and starts Docker Compose, optionally follows `api` logs, or prints manual Docker commands for later.
- `PM2 process manager`: checks Node.js, npm, and PM2, can install missing tools on supported Linux distributions, generates `ecosystem.config.cjs`, installs dependencies, builds, starts, configures startup, saves the process list, or prints manual PM2 commands for later.
- `Skip for now`: writes `.env` and prepares storage only.

## Update

Use the update script when a new self-hosted API version is available:

```bash
chmod +x scripts/update.sh
./scripts/update.sh
```

The updater checks that tracked files do not have local changes, fetches and pulls the current git branch with fast-forward only, refreshes npm packages, builds the API, and can restart Docker Compose or PM2. It does not modify `.env`, `uploads`, or `data`.

The first start after this update does tidy the thumbnails inside `uploads/.previews`: it moves the thumbnails of trashed items into the trash and deletes thumbnails whose file no longer exists. On a very large store that check takes a while, and the server starts listening only after it; the log shows `[thumbnail] Checking previews…` meanwhile.

## Nginx setup

The setup wizard can configure nginx after the runtime step:

```bash
./scripts/setup.sh
```

Choose `yes` at `Configure nginx reverse proxy now?`. The wizard explains the reverse proxy step, checks nginx, can install and start nginx on supported Linux distributions, asks for the public domain, reads the local API port and upload limit from the runtime values, checks whether the domain A record points to the current server, writes an nginx reverse proxy config, and can issue a Let's Encrypt certificate with certbot. Certbot is checked only if you choose HTTPS.

The generated nginx config is prepared for large file uploads: it aligns `client_max_body_size` with `MAX_FILE_SIZE`, disables request buffering for uploads, keeps `proxy_connect_timeout` at `60s`, and sets upload proxy/body timeouts to 30 minutes (`1800s`) so videos do not fail while the browser is still sending the request. Nginx also handles CORS for proxied API responses and preflight requests, including nginx-level upload errors, so the browser can show the real HTTP status instead of a generic CORS failure.

If DNS is not linked yet, create an A record from your domain to the server public IP, wait for propagation, then rerun the wizard before issuing the certificate.

If your API domain is behind a CDN, load balancer, or another proxy, make sure that layer also allows large uploads and long-running request bodies. If upload requests fail before they appear in nginx or Docker logs, check that upstream layer first or route upload traffic directly to the self-hosted API.

You can also skip the wizard and configure nginx or another reverse proxy manually. In that case, proxy the public domain to the local API port, keep upload limits aligned with `MAX_FILE_SIZE`, set upload-friendly proxy/body timeouts, and issue the HTTPS certificate through your normal deployment process.

## Verify the server

```bash
npm run health
```

By default, the health check reads `PORT` from `.env` and requests `http://localhost:<PORT>/health`. You can also pass a public API URL after nginx and HTTPS are configured:

```bash
npm run health -- https://files.example.com
```

The server is ready when the script prints `Health check passed`.

## Security

**Uploaded files are served as files, not as pages.** Anyone who holds the project's API key can
upload, so the server does not let an upload run in a visitor's browser:

- HTML, XHTML, SVG, XML and JavaScript files are sent with `Content-Disposition: attachment`: opening
  a link downloads the file. `<img src>` still shows an SVG and `<script src>` still loads a script.
- Every file is sent with `X-Content-Type-Options: nosniff`.
- A folder URL never serves an `index.html`.
- Paths with a segment that starts with a dot are not served. That covers the internal `.trash` and
  `.previews` folders: a file moved to the trash is no longer reachable by link. It also covers a
  folder of your own whose name starts with a dot: it is no longer served by link (it is still
  listed in the file manager).
- Thumbnails of trashed and deleted files are no longer public. A thumbnail goes to the trash with
  its file and comes back when the file is restored; deleting a file or a folder deletes its
  thumbnails, and uploading over a file replaces or removes its thumbnail. The trash list shows no
  thumbnails. Thumbnails of items that were already in the trash are hidden on the first start
  after the update, and orphaned thumbnails (those whose file is no longer stored at the same
  path) are removed at every start.

Files uploaded before this version are covered too: the headers are set when a file is served.

**Limits.** Per client address and minute; over a limit the API answers `429` with `Retry-After`.
Behind a CDN or a load balancer in front of your proxy, `TRUST_PROXY` must be the number of proxy
hops: otherwise all visitors share the CDN's address, and its limits. Set the limits in `.env`; the
defaults are:

| Variable | Default | Counts |
| --- | --- | --- |
| `RATE_LIMIT_API` | `600` | API calls |
| `RATE_LIMIT_UPLOAD` | `120` | uploads |
| `RATE_LIMIT_SEARCH` | `60` | searches |
| `RATE_LIMIT_STORAGE` | `60` | storage usage requests |
| `RATE_LIMIT_PREVIEW` | `1200` | preview images |
| `RATE_LIMIT_SETTINGS` | `30` | changes of the project settings (`PATCH /api/settings`) |
| `VALIDATION_ATTEMPT_LIMIT` | `60` | new key checks: requests with an API key the server has to ask the platform about |

Two limits are not per address but for all addresses together, per minute:
`VALIDATION_GLOBAL_LIMIT=300` for new key checks and `SETTINGS_UPDATE_GLOBAL_LIMIT=60` for changes
of the project settings. Over the first, and for 15 seconds after the validation service failed to
answer, a key the server does not know yet gets `503`; over the second, `PATCH /api/settings` gets
`503`.

A `503` that means "the validation service is unreachable, slow or held back by these limits" comes
with `Retry-After`. A `503` comes without it when retrying cannot help: `VALIDATION_SECRET` is not
set, or the validation service answered a key check with `403` (the key belongs to another project,
or the secret is wrong).

An address that sends 20 wrong or missing API keys within a minute has its new key checks refused
for 10 minutes (`KEY_FAILURE_LIMIT=20`, `KEY_FAILURE_WINDOW_SEC=60`, `KEY_FAILURE_BLOCK_SEC=600`).
A key the validation service answers `403` for counts as a wrong one, although the API answers `503`.

**API key checks.** A refused key is remembered for 60 seconds and a valid one for 15 minutes, so a
revoked key or a removed domain stops working within 15 minutes while the validation service is
reachable; if it is not, within 75 minutes. A key the server already knows keeps working for up to
an hour if the validation service is unreachable, and is never locked out by other clients'
failures from the same address.

**Behind a proxy.** The client address comes from `X-Forwarded-For` when the request arrives from a
private address: nginx on the same host or Docker's bridge network, as the setup wizard configures.
Set `TRUST_PROXY` if your proxy is elsewhere; `TRUST_PROXY=false` if nothing proxies the API.
With exactly one proxy in front, `TRUST_PROXY=1` is the strictest correct setting: the default also
trusts any other peer with a private address.

The address limits rely on that header. If the API port is reachable directly, not only through
your proxy, a client can then claim any address and so get around them. Bind the port to localhost
(for Docker: publish `127.0.0.1:3000:3000` in `docker-compose.yml`) or set `TRUST_PROXY=false`.

**What the API key is.** The key is visible to every visitor of a page that embeds the file manager,
and the allowed-domains check relies on the browser's `Origin` header. Treat the key as an identifier,
not a secret: put the file manager behind your own login if not every visitor may manage files.

## View logs manually

```bash
docker compose logs -f api
pm2 logs quq-self-hosted-api
```

Uploaded files are stored in `./uploads`; local metadata is stored in `./data`.
