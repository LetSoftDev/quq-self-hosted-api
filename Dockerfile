FROM node:20-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:20-bookworm-slim

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p uploads data

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV UPLOADS_DIR=/app/uploads
ENV DATA_DIR=/app/data

CMD ["node", "dist/index.js"]
