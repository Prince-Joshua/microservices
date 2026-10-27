# One image recipe for all four services (context = the service folder).
# Prisma services (orders, payments) are detected by prisma/schema.prisma.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

WORKDIR /app

# Dependencies first so they cache between code changes.
COPY package.json pnpm-lock.yaml .npmrc* ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN if [ -f prisma/schema.prisma ]; then pnpm exec prisma generate; fi \
 && pnpm run build

ENV NODE_ENV=production
USER node
CMD ["node", "dist/server.js"]
