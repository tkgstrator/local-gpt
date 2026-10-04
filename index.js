// Backward-compatible entry point. bun run start builds before launching this file.
const result = require('node:child_process').spawnSync(
  process.execPath,
  [require('node:path').join(__dirname, 'dist/server.cjs')],
  { stdio: 'inherit', env: process.env },
)

process.exitCode = result.status ?? 1
