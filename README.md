# QuqManager Self-Hosted API

Self-hosted file API for QuqManager. It stores files locally and validates project API keys through the QuqManager backend.

## Requirements

- Node.js 20+
- npm or pnpm

## Setup

```bash
cp .env.example .env
pnpm install
pnpm dev
```

The API starts on `http://localhost:3000` by default.

## Environment

```env
PORT=3000
UPLOADS_DIR=./uploads
DATA_DIR=./data
MAX_FILE_SIZE=52428800
NODE_ENV=development
BACKEND_PRO_URL=http://localhost:3001
VALIDATION_SECRET=vs_from_project_settings
```

`BACKEND_PRO_URL` points to the QuqManager backend that owns projects and API keys.
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
cp .env.example .env
docker compose up -d --build
```

Uploaded files are stored in `./uploads`; local metadata is stored in `./data`.
