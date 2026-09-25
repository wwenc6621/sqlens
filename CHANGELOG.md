# Changelog

All notable changes to Sqlens are documented here.

## 0.1.4 (2026-09-25)

### Features

- **Redis support (full)** — a `RedisDriver` implementing the full `DatabaseDriver` interface, backed by `ioredis` (bundled into the extension).
  - **Connection**: connect/disconnect, `PING`+`INFO` test, SSH tunnel + TLS (`rediss://`), and `options.redisMode` = `cluster` / `sentinel` (with `redisNodes` / `redisSentinelName`) reusing ioredis `Cluster` / Sentinel clients.
  - **Browse**: db-index list (db0..15), key-type groups (Strings/Hashes/Lists/Sets/ZSets/Streams/Other) via `SCAN TYPE`, and per-group key lists in the schema tree (paginated, with type/TTL/size tooltips). Double-click a key opens an **entry grid**.
  - **Grid + editing**: key-list grid (`key/type/ttl/size`) and per-key entry grid (hash fields, list items, set/zset members, string value, stream entries). Inline edits translate to `HSET/LSET/SADD/ZADD/SET/UNLINK`, TTL via `EXPIRE/PERSIST`, key delete via `UNLINK`; large values are truncated and big hashes capped (`HASH truncated` notice).
  - **Command editor**: the `.redis` document executes raw Redis commands (the editor is the CLI) with per-line CodeLens "Run".
- **MCP**: `SecurityGuard` is driver-aware — Redis commands are classified by command tables (read/write/danger), so AI `readOnly`/`writeMode` work; `maxRows` maps to `SCAN`/`COUNT`; the `run_query` tool describes Redis.
- **Dump/Import**: `Redis: Export to JSON` / `Redis: Import from JSON` commands on a Redis connection (context menu).
- **Settings**: `sqlens.redis.scanCount`, `sqlens.redis.maxValuePreview`, `sqlens.redis.blockedCommands`.
- **UI**: Redis-only export/import actions on the connection node; SQL-only actions (ER diagram, terminal, create-DB, dump/import) are hidden for Redis connections.
- New connection form opens directly (no database-type QuickPick). The form now has a database-type tab strip at the top with per-type brand-coloured icons; switching the tab changes the type (and default port) inline.
- Required fields in the New Connection form are marked with a red `*` (Connection Name, Host, Port, Username, SQLite Database File, Redis nodes / Master Name, SSH host / username / password).

### Improvements

- The connection-type icons are rendered by a new `DbTypeIcon` component, so adding drivers in the future only needs one row in the type list and one colour entry.
- Icons are the official brand logos from Simple Icons (CC0-1.0): MySQL dolphin, MariaDB seal, PostgreSQL elephant, SQLite feather, plus Redis/MongoDB/Elasticsearch/SQL Server. Connected rows in the Connections tree now use the brand-coloured icon (file-based, so the colour survives row selection); unconnected rows stay grey.

### Known limitations

- RESP-format dump/import (vs JSON) and `XTRIM`/consumer-group editing in the Stream grid are not implemented yet.
- Cluster mode uses db0 only (Redis does not support `SELECT` on clusters).

## 0.1.3 (2026-09-24)

### Performance

- Progressive schema tree loading for MySQL-family servers (MySQL/MariaDB/OceanBase): table names render immediately via `SHOW TABLES`, while row counts, sizes, and comments are hydrated in the background. On distributed databases like OceanBase, where the `information_schema.TABLES` stats query can take many seconds, the tree now appears instantly.

### Fixed

- Stale schema tree loads are discarded on disconnect or connection switch (a slow background load for a previous connection can no longer render its tables into the tree).

## 0.1.2 (2026-09-24)

### Fixed

- Cross-IDE password prompts: connecting now uses the password carried by the shared connections file first, instead of always asking SecretStorage (which is per-IDE). SecretStorage remains the fallback, and prompting is the last resort.

### Security

- Secrets in the shared connections file are stored AES-256-GCM encrypted (`enc:v1:...`) instead of plaintext. The 256-bit key lives in `<config dir>/.key` (0600).

## 0.1.1 (2026-09-24)

### Fixed

- Connections tree stayed empty when the shared-connections backend was enabled: saving wrote to the shared config file, but listing still read the legacy per-IDE storage. Both paths now use the same backend.

## 0.1.0 (2026-09-24)

First public release.

### Features

- Database connections for MySQL / MariaDB, PostgreSQL, and SQLite, with SSH tunnel support.
- Built-in SQLite viewer for `.db` / `.sqlite` / `.sqlite3` files, plus workspace auto-import of SQLite files.
- Schema browsing: tables, views, columns, indexes, and foreign keys, with inline column comments (truncated in the tree, full text on hover).
- Editable data grid: server-side pagination, sorting, WHERE filters, SQL-side column filters, inline editing with SQL preview, row add / duplicate / delete.
- Copy / export data as CSV, TSV, JSON, XML, SQL `INSERT` / `UPDATE` (current page or full table).
- SQL query workflow: CodeLens run actions, per-file connection/database context, query history, formatting, cancel, and EXPLAIN query plans.
- Visual table creation and structure editing with generated SQL batches — including primary key changes (`DROP / ADD PRIMARY KEY`).
- Database-level operations: create database, edit MySQL/MariaDB charset & collation, full database dump/import.
- Table data export & import, ER diagrams.
- Local MCP server for AI assistants (CodeBuddy, Trae, Trae CN, GitHub Copilot) with read-only mode, write confirmation, token protection, and an AI activity log.
- Project-level connections via `.sqlens.json` and `.env` auto-detection.

### Improvements

- Connections are shared across all VS Code forks on the machine (e.g. VS Code + Trae) via a single config file (`~/.config/sqlens/connections.json`, `%APPDATA%\sqlens\connections.json` on Windows); passwords included, file written with `0600` permissions.
- MCP registration covers CodeBuddy, Trae (intl., `~/.marscode`), Trae CN, and GitHub Copilot (user or workspace scope).
- Localized UI: English and Simplified Chinese, following the editor display language — command palette, views, notifications, prompts, and all webview panels.
- Tab strip right-click menu: Close / Close Others / Close All.
