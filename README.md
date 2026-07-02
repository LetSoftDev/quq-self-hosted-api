# QuqManager Self-Hosted API

Self-hosted file API for QuqManager. It stores files locally and validates project API keys through the QuqManager backend.

## Requirements

- Node.js 20+
- npm or pnpm

## Setup

```bash
chmod +x scripts/setup.sh
./scripts/setup.sh
pnpm install
pnpm dev
```

The API starts on `http://localhost:3000` by default.

The setup wizard asks for the public runtime values, creates storage folders automatically, and can configure PM2 keep-alive. `DATA_DIR` is always written as `./data`; you do not need to enter it manually. When the wizard asks for `VALIDATION_SECRET`, copy it from the QuqManager dashboard: `Projects -> select project -> Settings -> Validation Secret`.

## Environment

```env
PORT=3000
UPLOADS_DIR=./uploads
DATA_DIR=./data
MAX_FILE_SIZE=52428800
NODE_ENV=development
VALIDATION_SECRET=vs_from_project_settings
```

`VALIDATION_SECRET` must match the validation secret from the selected project settings.

## Scripts

```bash
pnpm dev
pnpm build
pnpm start
pnpm test
```

## Docker

```bash
./scripts/setup.sh
docker compose up -d --build
```

## PM2

Choose `PM2 process manager` in `scripts/setup.sh`. The wizard can install PM2, generate `ecosystem.config.cjs`, build the app, start it, and guide you through `pm2 startup` and `pm2 save`.

Uploaded files are stored in `./uploads`; local metadata is stored in `./data`.
