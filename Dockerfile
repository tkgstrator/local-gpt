FROM oven/bun:1.3.11
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN --mount=type=secret,id=browser_bridge,target=/app/.bridge-token,required=true bun run build
EXPOSE 8875 8766
CMD ["bun", "dist/server.cjs"]
