FROM oven/bun:1.3.11-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
COPY test ./test
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV DB_PATH=/data/suave.db
CMD ["bun", "src/index.ts"]
