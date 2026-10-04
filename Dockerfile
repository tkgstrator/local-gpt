FROM oven/bun:1.3.11
LABEL org.opencontainers.image.source="https://github.com/tkgstrator/local-gpt"
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN LOCALGPT_IMAGE_BUILD=1 bun run build
EXPOSE 8875 8766
ENTRYPOINT ["bun", "scripts/container-entrypoint.mjs"]
