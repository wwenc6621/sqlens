# Changelog

All notable changes to Sqlens are documented here.

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
