# Changelog

All notable changes to Sqlens are documented here.

## 0.5.2 (2026-10-08)

### Added

- **连接编辑页密码框支持显示原始密码**：数据库密码、SSH 密码 / 私钥口令、客户端密钥等所有密码输入框新增「眼睛」切换，可明文查看后核对。
- **连接节点右键新增「刷新数据库」**：在已连接的连接节点上右键即可重新拉取其数据库列表（原先仅数据库节点可刷新）。
- **连接节点新增「筛选数据库」**：连接节点内联新增筛选图标，点击后模糊输入关键字（支持子串与按序字符匹配），数据库子节点仅展示命中项；连接行以「已筛选」标记，可右键「清除数据库筛选」恢复全部。

### Fixed

- **已连接数据库点击「新建查询」误报「所选连接未激活」**：`sqlens.newQuery` 的 id 解析会把带前缀的树节点 id（`conn:` / `group:` / `db:`）当成连接 id，导致命中失效连接而报错。现改为只接受明确的连接来源（连接节点 `config.id`、数据库节点 `connectionId`），并在请求连接不可用时回退到当前活动连接，避免误报。
- **AI 通过 MCP 多次查询不再堆积标签页**：原先按「连接 + SQL」哈希建页签，AI 每执行一条不同 SQL 就新开一个页签。现改为 MCP 调用统一刷新同一个 AI 结果页签（`ai-result-live`）；用户从「AI 活动」面板点开记录时，则按记录各开一个页签，点开几个就是几个。

## 0.5.1 (2026-10-05)

### Fixed

- **点击「可视化」不再跳到 AI Activity 面板**：AI 只读查询的结果页签打开后，「AI 活动」面板的自动打开逻辑会抢走激活权，把视图切回去。现在当结果页签刚打开时，AI 活动面板只创建、不抢占激活，焦点留在结果页签上。
- **重复点击「可视化」不再新建多个图表页签**：图表页签 ID 改为按来源页签派生（`chart-<来源页签>`），再次点击会刷新同一个图表页签，而不是每点一次多开一个。

## 0.5.0 (2026-10-05)

### Added

- **查询结果可视化**：任意结果表格新增「可视化」按钮，在独立页签中用 ECharts 渲染柱状 / 折线 / 饼图；可切换维度与度量、导出 PNG。AI 查询结果同样适用。
- **AI 查询结果直接进入 Sqlens 面板**：AI 助手通过 MCP 执行的只读查询，其结果会以**只读数据表格**出现在结果面板（标题形如 `AI · CodeBuddy · 连接名`）；同一条 SQL 合并到同一页签，AI 活动记录可一键跳回，页签关闭后也能重开。结果页签上同样可以一键出图。
- **把已有表 / 列注释透给 AI**：MCP 的 `describe_table` 现在返回表注释与列注释（MySQL `TABLE_COMMENT` / `COLUMN_COMMENT`、PostgreSQL `obj_description` / `col_description`、SQL Server 扩展属性、ClickHouse `system.comment`），`search_schema` 支持按注释文本匹配，帮助 AI 写出更准确的 SQL；SQLite / MongoDB 无原生注释时不报错。
- **保存为查询 / 仪表盘**：任意结果或图表页签可「保存为查询」（写入该连接的已保存查询），或「添加到仪表盘」；仪表盘以卡片网格展示（图表 / 表格卡片），支持手动刷新与移除卡片，持久化在本机（跨项目），重开 IDE 仍在。

### Changed

- MCP `describe_table` / `search_schema` 的工具描述更新，说明其会返回 / 匹配表与列的注释。

### Testing

- 单元测试新增图表数据整形、AI 结果桥接（同 SQL 合并 / LRU 淘汰）、仪表盘持久化，以及 MCP 注释透传的用例；`npm run test:unit` 共 70 项。

## 0.4.1 (2026-09-29)

### Added

- **连接导入全面增强（新解析管线）**：导入不再局限于 sqlens JSON，新增统一的格式嗅探管线（`parseConnections`），粘贴或选择文件后自动识别格式，复用既有的保存链路（机器绑定 `enc:` 密文丢弃、ID 冲突重生成、名称去重）。
- **连接 URI 导入**：支持 `mysql://`、`postgres://`、`redis://`、`rediss://`（自动 TLS）、`mongodb+srv://`、`sqlserver://`、`clickhouse://`、`es://`、`sqlite://` 等标准连接串，逐行批量解析；`sslmode` 参数映射到 SSL 配置，`ssh=true&ssh_host=...` 扩展参数映射 SSH 隧道。
- **CSV / TSV 网格导入**：从 Excel / 飞书表格 / DataGrid 复制一块连接清单（一行一个连接）直接粘贴导入，支持中英文表头别名（名称/主机/端口/用户名/密码/数据库/分组/标签/跳板机等），引号转义兼容 RFC 4180；无可识别表头时拒绝解析，避免静默错配。
- **`.env` 文件导入**：识别 `DATABASE_URL=mysql://...` 类 URL 键与 `MYSQL_HOST/PORT/USER/PASSWORD/DB` 类拆解键，前缀归组推断数据库类型。
- **后端配置文件导入（Spring）**：直接粘贴 `application.yml` / `application.properties` —— 解析 `spring.datasource.url`（JDBC URL + `useSSL`/`sslmode` 映射，其余参数进 options）与 `spring.datasource.username/password`；同时支持 `spring.redis.*`、`spring.data.redis.*`、`spring.data.mongodb.*`、`spring.elasticsearch.uris` 等拆解键（YAML 按缩进作用域归组，配置文件中的明文密码按原样导入）。
- **第三方工具迁移**：
  - **DBeaver**：`data-sources.json`（含 JDBC URL 兜底解析）。
  - **DataGrip**：右键连接 → Copy Settings 的 `#DataSourceSettings#` 输出，直接粘贴即可（`jdbc-url` 属性/元素两种形态、`&amp;` 实体解码、`useSSL=false` → SSL 关闭，其余 JDBC 参数进 options）。
  - **Navicat**：明文 `.ncx`（per-provider 标签与 `<server><general>` 两种形态，SQLite 文件路径属性）。
  - **TablePlus**：导出 JSON（裸数组或 `Connections` 数组，字段别名大小写不敏感，SSL/SSH 字段映射）。
  - 四个工具的密码均不在导入范围内（Navicat 加密、TablePlus 在 Keychain、DataGrip/DBeaver 不导出），一律置空并在预览中以 ⚠ 提示，连接前手动补齐。
- **导入向导面板**：新的两步导入页（命令 `Sqlens: Import Connections…`，连接视图标题栏新按钮）——第一步拖放文件或粘贴内容、实时嗅探、选择目标分组；第二步预览确认（勾选、问题标记、行内改名/分组），密码永不回显。原 QuickPick 导入与格式化对话框保留为快速路径。
- **新命令** `Sqlens: Import Connections from Clipboard`（剪贴板自动嗅探导入）与 `Sqlens: Copy Connection as URI`（复制连接为标准 URI，不含密码）。

### Fixed

- 修复一条 webview 文案（"Copy Table"）缺失中文翻译导致的 i18n 覆盖测试失败。

## 0.4.0 (2026-09-28)

### Fixed

- **Connections 树的右键菜单项不再泄漏到其他扩展的树视图右键菜单。** 部分 VS Code 版本对菜单 `when` 条件中的负正则（`viewItem !~ /.../`）求值错误，导致 “Dump Database”“ER Diagram”“Open Terminal CLI”“Create Database” 等条目出现在无关树视图（例如同装 Pico 时，Pico 的请求列表右键菜单）里。0.4.0 为连接与数据库节点新增显式的 `:rdb` / `:nordb` 上下文标签，并把全部负正则条件改写为等价的肯定匹配（`viewItem =~ /:rdb$/`），不再依赖该缺陷运算符。

## 0.3.9 (2026-09-28)

### Changed

- **Queries 视图空状态不再显示 “New Saved Query” 链接**，只保留说明文字；新建入口统一在标题栏的「新建」图标按钮（0.3.7 引入）。

## 0.3.8 (2026-09-28)

### Fixed

- **Queries 视图空状态文案显示了多余的 `%` 符号。** 移除 “Create Connection” 按钮后，本地化 key 与文案不一致导致 VS Code 找不到翻译条目，`%...%` 被原样渲染；已同步 nls key，中英文均正常显示。

## 0.3.7 (2026-09-28)

### Changed

- **Connections 视图：展开数据库改为双击。** 单击数据库仅选中、不再误触切换；双击才切换为当前活动库（与未连接连接的双击连接行为一致）。
- **侧边栏标题统一为单词形式。** “Saved SQL” 视图重命名为 **Queries**（中文「已保存 SQL」→「查询」），与 Connections / Schema 风格一致。
- **Queries 视图欢迎页移除 “Create Connection” 链接**；「New Saved Query」改为标题栏的「新建」图标按钮（无选中连接时弹出连接选择框）。

## 0.3.6 (2026-09-27)

### Added

- **Copy Table in the Schema context menu.** Right-click → **Copy Table** prompts for a new name (default `{table}_copy`) and copies structure and data in one step — `CREATE TABLE ... LIKE` + `INSERT ... SELECT` on MySQL, `CREATE TABLE ... AS SELECT` on PostgreSQL/SQLite — then refreshes the schema tree.
- **The MCP title-bar button now toggles the panel.** Clicking it opens the MCP Server panel as before; clicking again closes the tab while it is on screen.

### Changed

- **Write confirmations appear in the AI Activity panel only.** The duplicate non-modal notification was removed; the panel is still revealed and focused when a confirmation is pending (`sqlens.mcp.focusOnConfirm`), so requests can no longer be missed.
- **MCP panel switch labels are no longer forced to uppercase** — they now read **Read Only**, **Read & Write**, **Auto Approve** and **Confirm writes**. The auto-approve explanation (including the DROP/TRUNCATE note) moved from the red banner into the switch's hover tooltip.

## 0.3.5 (2026-09-26)

### Added

- **The Schema view is now a webview, with an inline filter and in-place rename.** The filter icon in the view title bar expands a text box right there in the panel (no modal dialog) and the tree narrows as you type, `*` / `?` wildcards included. Right-click → **Rename** turns the table name into an input on its own row; Enter commits, Escape cancels, and invalid names are reported inline instead of in a separate prompt.
- **Tables and views expand by default** again (the old native tree created its groups with `CollapsibleState.Expanded`). Groups you collapse yourself stay collapsed across refreshes; changing connection resets that.
- **A proper right-click menu on tables**: Open Table, View Structure, Show DDL, Copy CREATE TABLE, Generate Test Data, Export / Import Data, Rename, Truncate Table, Drop Table — shown only when the active driver supports them, with destructive entries in red.

### Changed

- **The MCP panel's access switch now reads the right way round:** the switch is on for **Read & Write**, off for **Read-only**. It maps to the same `sqlens.mcp.readOnly` setting as before, so existing configuration keeps its meaning.
- **The Schema view now matches the Connections tree next to it**: same sidebar font family / size / weight and text colour, object names in semibold with muted row counts, types and comments, and the panel background uses the sidebar colour rather than the editor colour (which made the two areas visibly different in most themes).

### Fixed

- **MySQL views were listed under "Tables"** until the background statistics query corrected their type. The fast listing now uses `SHOW FULL TABLES`, which returns the table type at the same cost, so views land in **Views** straight away.

## 0.3.4 (2026-09-26)

### Added

- **Schema tree filter.** A filter button in the Schema view header opens a live filter input: the tree narrows as you type, `*` and `?` wildcards are supported, and the qualified `schema.table` form (e.g. `public.users`) matches too. The active pattern is shown in the view header with a one-click clear button, and a filtered group reports `matched / total` so hidden objects are visible instead of silently missing. Escape restores the previous pattern, and switching connections clears the filter.
- **"Auto-approve" switch in the MCP Server panel.** It flips `sqlens.mcp.writeMode` between `confirm` and `allow`; with `allow` the AI executes writes without asking.

### Changed

- **Write confirmations can no longer be missed.** When the AI asks to run a write, Sqlens now reveals the query panel and activates the AI Activity tab instead of only updating it when it happens to be on screen — a confirmation card the user never noticed used to end as a timeout-denial. A non-modal notification with **Allow** / **Deny** buttons is shown as well, so the request is actionable from anywhere. Both are configurable via `sqlens.mcp.focusOnConfirm` and `sqlens.mcp.confirmNotification`, and `sqlens.mcp.autoConfirmTimeout` is now declared in Settings with a 120 s default (was an undeclared 30 s).
- **`writeMode: "allow"` now also permits CREATE/ALTER**, so the auto-approve switch covers the DDL the AI needs. `DROP`, `TRUNCATE` and destructive admin commands are classified as unconditionally refused and stay blocked in every mode, including auto-approve. The `write_query` tool description and the panel banner both state the active mode.
- The second MCP panel switch is disabled while the server is in read-only mode, since writes cannot run at all then.

## 0.3.3 (2026-09-26)

### Improved

- **AI Activity now shows the real assistant** ("CodeBuddy", "Claude Code", "GitHub Copilot", …) instead of the generic `ai-assistant`. The name comes from the `initialize` request's `clientInfo` and is remembered for the session, because later `tools/call` requests carry no client info; an unrecognised/absent name falls back to a recognised `User-Agent` product token, and common assistants keep their proper casing.
- MCP smoke tests extended to cover the name memory and the User-Agent fallback (HTTP-library agents such as `undici` are ignored).

## 0.3.2 (2026-09-26)

### Fixed

- **MCP server returned `500 {"error":"Internal error"}` for every request** — `explain_query` ended up registered twice, so building the MCP server threw and no tool could be called (clients showed "0 tools"). The duplicate registration is gone and the server answers `initialize` / `tools/list` normally. The stateless transport still answers `405` to the client's SSE probe, which is correct.

### Testing

- Added **MCP smoke tests** (`tests/mcp.test.ts`): boot the real HTTP server with a stubbed host, then assert `initialize` succeeds, every tool name is unique, and requests without the bearer token get `401`. This runs in `npm run test:unit` and in CI, so a duplicated tool registration fails the build instead of silently disabling AI access.
- Test bundles (`dist-tests/`) are git-ignored and excluded from the VSIX.

## 0.3.1 (2026-09-26)

### Testing & CI

- **GitHub Actions CI**: a quality job (type-check, extension + webview build, unit tests) and an integration job that starts Elasticsearch / MongoDB / ClickHouse / SQL Server service containers and runs every driver suite (`scripts/run-integration.sh`, credentials via `SQLENS_CH_PASSWORD` / `SQLENS_MSSQL_PASSWORD`).
- **Offline unit tests** (`npm run test:unit`, Node's built-in test runner, no extra dependencies): statement classification for all five drivers, ClickHouse/ES/T-SQL type normalization, Elasticsearch request parsing, mongosh call parsing, and an i18n coverage guard.
- The suite immediately caught three real defects, all fixed here: SQL Server `DROP DATABASE/TABLE` was not classified as danger, Elasticsearch's indexed read paths (`POST /idx/_search`) were misclassified as writes for AI calls, and 16 webview strings had no Chinese translation.

### Robustness

- **Query cancellation** now works on PostgreSQL (`pg_cancel_backend`), MySQL (`KILL QUERY`) and SQL Server (`request.cancel()`), joining ClickHouse's `KILL QUERY`; SQLite/MongoDB/Elasticsearch document why cancellation is not offered.
- Fixed a long-standing type error around the optional MCP service reference and a stray Vietnamese string in the data grid.

### MCP & data tooling

- New **`explain_query`** MCP tool: returns an execution plan without executing the query (EXPLAIN / EXPLAIN QUERY PLAN / SET STATISTICS PROFILE / `cursor.explain()` / ES `profile`).
- New AI access controls: `sqlens.mcp.allowedConnections` (ids or names; empty = all) and `sqlens.mcp.blockedTables` (tables/collections/indexes the AI may never touch), enforced on every read and write tool call.
- **Generate Test Data (INSERT)**: right-click a table to generate type-appropriate INSERT statements (identity columns skipped) into a new editor for review.
- README (both languages) documents the query syntax for every driver.

## 0.3.0 (2026-09-26)

### Fixed

- **Extension failed to load when the Elasticsearch driver was bundled** — `@elastic/elasticsearch` require its optional `apache-arrow/Arrow.node` binding at module load, which the package does not ship, so the whole extension threw `MODULE_NOT_FOUND` and every view (including the connection list) came up empty. The bundler now aliases that specifier to an empty shim, and the ES client is loaded lazily on connect. Also fixed SQL Server table statistics (row count / size) being dropped because unnamed expression columns collapsed each other.

### New database engines

- **Elasticsearch** (official 8.x client): index tree, mapping field tree, Kibana-style request editor (`GET /index/_search` + JSON body, or a bare JSON body), read-only grid with `_id` first and dot-flattened `_source`; in-grid document editing (index/update/delete); deep-pagination guard for the `from + size` window.
- **MongoDB** (official driver): database/collection tree, sampled field tree, mongosh-style editor (`db.coll.find({...}).sort().limit()`, `countDocuments`, `distinct`, `aggregate`, and full CRUD) parsed structurally — user JS is never evaluated; in-grid editing via `$set`/`insertOne`/`deleteOne`; BSON rendering (ObjectId hex, ISO dates, JSON cells) with value-preview truncation.
- **SQL Server** (official `mssql`/tedious): T-SQL dialect (bracketed identifiers, `N''` literals, `OFFSET/FETCH` pagination, `GO` batch splitting), introspection via `sys.*` + `dm_db_partition_stats`, schema tree, read-only grid.
- **ClickHouse** (P2 additions): `KILL QUERY` cancellation, data-skipping indices, in-grid mutation editing (opt-in), system-database hiding, per-value truncation.

### MCP security

- Statement classification is now **driver-aware** via a `StatementClassifier` registry: SQL family, Redis command tables, Elasticsearch method/path rules, MongoDB method rules, ClickHouse mutations and T-SQL danger commands (`TRUNCATE`, `xp_cmdshell`, `BULK INSERT`, ...). Unrecognised requests are treated conservatively.
- `maxRows` maps to the driver's native cap: `LIMIT` (SQL/ClickHouse), `size` (Elasticsearch), `.limit()`/`$limit` (MongoDB); tool descriptions now document each driver's input syntax.

### Engine-specific completeness (P2–P4)

- **SQL Server**: TLS/auth switches in the connection form (encrypt, trust self-signed, Windows NTLM, Azure AD service principal), `IDENTITY_INSERT` when inserting an identity value, `SET STATISTICS PROFILE` for EXPLAIN, primary-key `ORDER BY` for stable OFFSET/FETCH paging, and multi-result-set batches (stored procedures / several SELECTs) open each additional result in its own read-only tab. Export supports the built-in T-SQL INSERT script (with CREATE TABLE) and a high-speed `bcp` export with a clear install hint when the tools are missing.
- **Elasticsearch**: index create/delete, NDJSON export/import, `profile: true` EXPLAIN, aggregation responses rendered as one row per bucket with a text bar column, Elastic Cloud ID support, driver-side paging that switches to a `search_after` cursor once the `from + size` window is exceeded (deep jumps are guided).
- **MongoDB**: collection create, index create, JSON export/import, `cursor.explain()`, connection-string (Atlas SRV) field, gated mongosh passthrough (stats/listIndexes/validate/drop/renameCollection), and paging that switches from skip/limit to a fast `_id` range cursor when paging forward past the deep-skip threshold.
- **ClickHouse**: `FORMAT` export (CSV/TSV/JSONEachRow/JSON/PrettyCompact), sorting-key `ORDER BY` for stable paging.
- **Grid paging** now uses each driver's native query (from/size, skip/limit, OFFSET/FETCH, LIMIT/OFFSET) instead of generated SQL, so non-SQL tables can be browsed and paged.
- **Formatting** is dialect-aware (T-SQL / PostgreSQL / MySQL) and falls back to JSON formatting for Elasticsearch requests and mongosh calls.
- **Views** are read-only nodes: rename/drop/truncate/structure menus no longer appear on them.
- Registered `.es` and `.mongo` languages.

### Settings

- Added the full per-driver setting set: `sqlens.clickhouse.*` (stringMaxBytes, allowMutations, showSystemDatabase, requireOrderByPagination, useBackticks), `sqlens.es.*` (showSystemIndices, requestTimeout, maxResultWindow), `sqlens.mongo.*` (sampleSize, maxValuePreview, allowShellEval), `sqlens.mssql.*` (encrypt, trustServerCertificate, requestTimeout).

### UI

- The **MCP Server panel no longer opens automatically** on startup; use the title-bar button or the command palette when you need it (the AI Activity tab still opens on first AI activity).
- Progressive tree loading for every driver that exposes a cheap name listing (system tables, `sys.tables`, `_cat/indices`, `listCollections`).
- Relational-only actions (ER diagram, structure editing, DDL, SQL dump, EXPLAIN) are hidden on non-relational connections.
- **Connection import/export**: export selected connections to JSON (passwords stripped by default; opt-in plaintext behind a modal warning) and import them back (id/name collision handling, machine-bound secrets dropped).
- Double-click a disconnected connection to connect (single click only selects).

## 0.2.0 (2026-09-25)

### ClickHouse support (P1)

- New **ClickHouse** database type (HTTP protocol via the official `@clickhouse/client`, default port 8123): connect, test connection, database/table tree, SQL editor, and a read-only result grid.
- ClickHouse-specific introspection via `system.databases` / `system.tables` / `system.columns` (no `information_schema`); no schema layer and no foreign keys; the "primary key" reported is the engine's sorting key (`ORDER BY`).
- Rich type mapping for the grid: `Array` / `Map` / `Tuple` / `Nested` arrive as native JSON values, `Nullable` marks columns nullable, `Bool` / `Date` / `DateTime64` / `Enum` / `UUID` / `IPv4` / `IPv6` / `LowCardinality` all normalize correctly.
- Writes (`INSERT` / `CREATE` / `ALTER ... UPDATE|DELETE` mutations / etc.) run through the command path and report affected rows, with a reminder that mutations are asynchronous in ClickHouse.
- Brand icon and yellow label colour in the connection form, sidebar, and webview; ClickHouse added to the MCP connection types.

### Sidebar icons

- Replaced the per-type tinted cylinder SVGs (`dbnode-*.svg`, `database-green.svg`, `database-grey.svg`, `file-green.svg`) with the built-in `$(database)` / `$(file)` codicons tinted by theme colour tokens via `vscode.ThemeIcon` — active databases render in the type's brand colour, inactive ones in grey (same glyph). A shared connection-icon helper makes the Connections and Saved SQL views show identical icons per connection.

## 0.1.7 (2026-09-25)

### Sidebar icons

- Replaced the per-type tinted cylinder SVGs (`dbnode-*.svg`, `database-green.svg`, `database-grey.svg`, `file-green.svg`) with the built-in `$(database)` / `$(file)` codicons tinted by brand colour via `vscode.ThemeIcon` + `vscode.ThemeColor`. Active databases now show the codicon in the type's brand colour; inactive databases show it in grey — same glyph, colour signals state. A single `DB_BRAND_COLOR` map replaces a dozen icon files to maintain.
- Connection-level fallback icons (when a `db-<type>.svg` brand logo is missing) also use the tinted codicons instead of the green/grey cylinder SVGs. Brand logo SVGs (`db-<type>.svg` / `db-<type>-grey.svg`) are still used at the connection level.

## 0.1.6 (2026-09-25)

### Branding / Assets

- **Unified Sqlens logo** — the extension icon, the activity-bar icon, the result-panel tab icon, and standalone editor-panel (ER diagram / data grid) icons now all use the composed logo: a grey `database` glyph with a green `MCP` badge in the bottom-right corner.
- **Asset reorganization** — all runtime icons and the logo were moved from `media/` into `resources/icons/`; README screenshots were moved to `docs/screenshots/` (kept in the package via a `.vscodeignore` exception so the Marketplace README still renders). `media/` was removed.
- Removed the now-unused `database.svg` (superseded by the composed logo).

## 0.1.5 (2026-09-25)

### Features

- **MCP Server panel** — a dedicated tab in the Sqlens result panel for monitoring and operating the local MCP server.
  - Shows server status (running/stopped), the bound endpoint (`http://127.0.0.1:<port>/mcp`), the bearer token (reveal/copy/regenerate), and the current access mode (read-only / read-write).
  - Lists every known AI assistant and whether it is already registered (CodeBuddy / Trae / Trae CN / Copilot).
  - When `sqlens.mcp.enabled` is on and the result panel is empty, the MCP panel opens by default (closable; closing returns to the "Nothing open yet" empty state).
  - Live-refreshes whenever the server starts/stops or the token is regenerated.
  - New command `Sqlens: Open MCP Server Panel` (also reachable from the result panel title bar).

### UI / UX

- Connections sidebar and result-panel title bars both gained an **Open MCP Server Panel** button (icon `$(mcp)`).
- The MCP panel header is a compact icon-button row: **Refresh**, **Start/Stop Server**, **Register to Assistant...**, plus the **Access Mode** toggle switch placed inline next to the running/stopped badge (hover shows the current mode).
- The **open-MCP icon turns green while the server is running** and reverts to grey when stopped (a dedicated green `mcp` icon is used for the running state).
- The Endpoint and Bearer Token sections are **merged into one card** with a full-width **Copy MCP Config** button that copies the complete config JSON (endpoint + `Authorization: Bearer <token>`), ready to paste into any assistant.
- The MCP panel now **fills the panel width** and **scrolls vertically** when content overflows; the running badge's status dot is green.

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
