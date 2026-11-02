# Stub for the paused browser pool (README). Build context is this directory.
FROM node:26.12.1-bookworm-slim

WORKDIR /app
COPY stub.mjs ./
USER node
ENV PORT=3000 \
    CDP_PORT=9222
EXPOSE 3000 9222
CMD ["node", "/app/stub.mjs"]
