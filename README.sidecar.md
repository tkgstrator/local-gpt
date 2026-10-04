# LocalGPT + LocalMCP with Docker Compose

Download only `compose.yaml` and start both servers; no clone, host Bun installation, or `setup:sidecar` command is required.

```sh
curl -fsSLO https://raw.githubusercontent.com/tkgstrator/local-gpt/master/compose.yaml
docker compose up -d
```

The `credentials` service initializes private keys in a named volume and exits successfully. LocalMCP waits for initialization; LocalGPT waits for the sidecar health check. LocalGPT generates paired browser downloads inside its container at startup. Published images contain no installation credentials. Download the extension ZIP from http://127.0.0.1:8766/, extract it and load it in the host Chrome with developer mode. Chrome must remain logged into ChatGPT.

Register only `http://127.0.0.1:8766/mcp` in Codex Desktop. LocalGPT exposes `localgpt_*` chat tools and forwards the allowlisted `localmcp_*` file/command tools to `http://local-mcp:8080/local` inside Compose. Codex Desktop orchestrates the two sets of tools. ChatGPT itself does not directly call the local sidecar.

## Storage and host files

Both servers mount the `workspace` named volume at `/workspace`. File tools accept paths relative to this shared root. To work on an existing host source/log folder, replace `workspace:/workspace` in **both** services with the same bind mount, such as `./workspace:/workspace`, and create that host folder before startup. Attachment paths refer to `/workspace/...` inside LocalGPT, rather than a Mac host path.

Keys, LocalGPT sessions and LocalMCP state use separate persistent named volumes. `stop` and `down` preserve these volumes; `down -v` deletes them, including shared files and pairing keys. Ports 8766, 8875 and 8876 are bound only to host loopback. No public tunnel, Docker socket, SSH keys or Git credentials are mounted.

```sh
docker compose logs --tail=100
docker compose stop
docker compose pull
docker compose up -d
```

Set `LOCALMCP_ALLOW_EXEC=false` in your shell or a Compose `.env` file to disable the command tools. Recreate the services and reconnect the MCP client after changing this setting. The dashboard file-operation status and `localmcp_status` report connectivity.

## Existing installations and development

This standalone Compose deployment generates its own keys and starts with its own session volume. If you previously used a host Bun server, stop it before startup to free 8766/8875, then install the extension downloaded from the new deployment. Existing host sessions are not automatically imported. Preserve the old key and SQLite files when migrating; do not assume previous session IDs survive a fresh deployment.

The old `setup:sidecar` helper is retained only for source-based development/legacy configuration. It is not part of this deployment procedure.

LocalMCP upstream: https://github.com/tkgstrator/local-mcp (MIT). The Rust image is pinned by digest. LocalGPT publishes multi-platform images to `ghcr.io/tkgstrator/local-gpt` after Integration CI succeeds on master.
