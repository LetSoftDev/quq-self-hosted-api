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
- Node.js 20+ and npm when running with PM2.
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

The wizard writes the runtime configuration for you. If your deployment needs it, you can also set the same values manually instead of using the wizard: port, uploads directory, max file size, node environment, and Validation Secret.

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

## Nginx setup

The setup wizard can configure nginx after the runtime step:

```bash
./scripts/setup.sh
```

Choose `yes` at `Configure nginx reverse proxy now?`. The wizard explains the reverse proxy step, checks nginx, can install and start nginx on supported Linux distributions, asks for the public domain, reads the local API port and upload limit from the runtime values, checks whether the domain A record points to the current server, writes an nginx reverse proxy config, and can issue a Let's Encrypt certificate with certbot. Certbot is checked only if you choose HTTPS.

The generated nginx config is prepared for large file uploads: it aligns `client_max_body_size` with `MAX_FILE_SIZE`, disables request buffering for uploads, and sets longer proxy/body timeouts so videos do not fail while the browser is still sending the request.

If DNS is not linked yet, create an A record from your domain to the server public IP, wait for propagation, then rerun the wizard before issuing the certificate.

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

## View logs manually

```bash
docker compose logs -f api
pm2 logs quq-self-hosted-api
```

Uploaded files are stored in `./uploads`; local metadata is stored in `./data`.
