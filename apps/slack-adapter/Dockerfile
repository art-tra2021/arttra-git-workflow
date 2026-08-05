ARG AR_BUILD_REVISION

FROM oven/bun:1.3.14-slim AS dependencies

WORKDIR /app
COPY apps/slack-adapter/package.json apps/slack-adapter/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM node:24.18.1-bookworm-slim AS runtime

ARG AR_BUILD_REVISION

RUN test "$(printf '%s' "${AR_BUILD_REVISION}" | wc -c)" -eq 40 \
    && ! printf '%s' "${AR_BUILD_REVISION}" | grep -q '[^0-9a-f]'

ENV NODE_ENV=production
ENV PORT=8080
ENV AR_SLACK_TRANSPORT=http
ENV AR_STATE_BACKEND=firestore
ENV AR_GITHUB_BACKEND=app
ENV AR_JOB_QUEUE=cloud-tasks
ENV AR_BUILD_REVISION=${AR_BUILD_REVISION}

LABEL org.opencontainers.image.revision=${AR_BUILD_REVISION}

WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node apps/slack-adapter/package.json ./package.json
COPY --chown=node:node apps/slack-adapter/src ./src

USER node
EXPOSE 8080
CMD ["node", "src/start.ts"]
