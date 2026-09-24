# Sqlens — VS Code 数据库客户端 & MCP

[English](./README.en.md) | [简体中文](./README.md)

Sqlens 是一个完全免费的 VS Code 扩展，用于浏览数据库、运行 SQL、编辑表数据、管理本地 SQLite 文件，并内置 MCP 服务器，让 AI 助手（CodeBuddy、Trae、GitHub Copilot 等）也能查询你的数据库。

支持 VS Code 及其衍生 IDE（如 Trae），界面语言自动跟随编辑器显示语言（英文 / 简体中文）。

## 功能

- 在 Sqlens 侧边栏管理数据库连接。
- 连接 MySQL、PostgreSQL、SQLite 数据库。
- 内置 SQLite 查看器，直接打开 `.db`、`.sqlite`、`.sqlite3` 文件。
- 浏览库、表、视图、列、索引、外键。
- 可编辑数据表格（排序、筛选、分页、行内编辑）。
- 在 `.sql` 文件中通过 CodeLens 运行查询，支持按文件选择连接和数据库上下文。
- 行/页数据复制为 CSV、TSV、JSON、XML、SQL `INSERT` / `UPDATE`。
- 内嵌 Quick View 侧栏查看行详情和长文本。
- 可视化建表和改表结构，自动生成 SQL 批次。
- 新建数据库、修改 MySQL/MariaDB 字符集与排序规则、整库导出导入。
- 表数据导入导出、ER 图、查询执行计划。
- 项目级连接配置 `.sqlens.json`、SSH 隧道、`.env` 自动识别。
- 连接配置在本机所有 VS Code 系 IDE 之间共享（可选）。
- 界面支持英文和简体中文，自动跟随编辑器语言。

## 支持的数据库

| 数据库 | 状态 |
| --- | --- |
| MySQL / MariaDB 兼容 | 已支持 |
| PostgreSQL | 已支持 |
| SQLite | 通过 `sql.js` 支持 |
| Redis、MongoDB、MSSQL | 规划中 |

## 快速开始

1. 从 [VS Code 插件市场](https://marketplace.visualstudio.com/items?itemName=wwenc6621.sqlens-vscode) 安装。
2. 打开活动栏中的 Sqlens 视图。
3. 点击 **新建连接**，选择数据库类型并填写连接信息。
4. 点击 **测试**，然后 **保存** 并 **连接**。

```bash
code --install-extension wwenc6621.sqlens-vscode
```

手动安装 VSIX：参见 [INSTALL_VSIX.md](./INSTALL_VSIX.md)。

## MCP 服务器（供 AI 助手使用）

Sqlens 内置本地 MCP（Model Context Protocol）服务器。启动后，CodeBuddy、Trae、Trae CN、GitHub Copilot 等 AI 助手可以通过你保存的连接列出表、执行只读查询，也可以（可选）执行写入操作。

### 1. 启用服务器

扩展激活时 MCP 服务器会自动启动（默认开启）。相关设置：

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `sqlens.mcp.enabled` | `true` | 启动本地 MCP 服务器 |
| `sqlens.mcp.port` | `37421` | 服务器端口（`0` = 自动）；被占用时自动回退到附近端口 |
| `sqlens.mcp.readOnly` | `true` | 仅允许只读语句（`SELECT/SHOW/DESCRIBE/EXPLAIN`） |
| `sqlens.mcp.writeMode` | `confirm` | 写入处理方式：`confirm`（确认）/ `allow`（允许）/ `deny`（拒绝） |
| `sqlens.mcp.maxRows` | `100` | 每次查询返回的最大行数 |
| `sqlens.mcp.maskSensitiveColumns` | `true` | 对结果中密码/令牌类列做掩码 |
| `sqlens.mcp.activityRetention` | `200` | 保留的 AI 活动记录条数 |

### 2. 注册到 AI 助手

运行命令 **Sqlens: 将 MCP 服务器注册到 AI 助手…**，选择一个或多个助手。Sqlens 只写入自己的 `sqlens` 条目，不影响其他配置：

| 助手 | 配置文件 |
| --- | --- |
| CodeBuddy | `~/.codebuddy/mcp.json` |
| Trae | `~/.marscode/vscode.mcp.config.json`、`~/.trae/mcp.json` 等 |
| Trae CN | `~/Library/Application Support/Trae CN/User/mcp.json`（macOS） |
| GitHub Copilot | 用户级 `.../Code/User/mcp.json` 或工作区 `.vscode/mcp.json` |

注册后请重启助手的会话窗口。也可以通过 **Sqlens: 复制 MCP 配置片段** 手动复制，格式如下：

```json
{
  "mcpServers": {
    "sqlens": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:37421/mcp"],
      "env": { "MCP_TOKEN": "<你的令牌>" }
    }
  }
}
```

### 3. 安全模型

- 服务器只监听 `127.0.0.1`，并使用本机安装唯一的令牌保护。
- `readOnly` 模式下，AI 助手的写入语句会被直接拒绝。
- `confirm` 写入模式下，每次写入请求都会弹出确认对话框；所有 AI 调用都会记录在 **AI 活动** 面板中（`sqlens.mcp.showActivity`）。

## 跨 IDE 共享连接

默认情况下，Sqlens 把连接保存到统一的共享配置文件中，在 VS Code 里创建的连接会自动出现在同机的 Trae 等 IDE 中：

- macOS / Linux：`~/.config/sqlens/connections.json`
- Windows：`%APPDATA%\sqlens\connections.json`

如需按 IDE 隔离存储，关闭 `sqlens.sharedConnections` 即可。

## SQLite 文件

Sqlens 为 `*.db`、`*.sqlite`、`*.sqlite3` 注册了自定义编辑器。工作区扫描会自动导入项目中的 SQLite 文件（排除 `node_modules`、`.git`、`dist`、`build` 等目录）。

## 查询工作流

打开或新建 `.sql` 文件后可以使用：

- 语句上方的 **运行** CodeLens，或 **运行全部语句**。
- **更改查询数据库上下文** 选择目标连接/数据库。
- **新建查询** 基于活动连接创建 SQL 文档。
- 编辑器右键菜单中的 **格式化 SQL**、**查询历史**、**查看执行计划**。

## 结构编辑

- 结构视图标题栏的 **新建数据表**。
- 表右键菜单的 **编辑表结构**：列、索引、外键、重命名、字符集。
- 多个标签页生成的 SQL 会合并到同一个预览中，一次性执行。
- 生成的 SQL 在执行前可以手动修改。

## 数据表格

- 服务端分页、排序、WHERE 筛选、SQL 级列筛选。
- 列筛选操作符根据列类型自动选择；可在输入前缀（`>`、`>=`、`~`、`^`、`$`、`=`…）覆盖。
- **列** 按钮可自定义列的显示/隐藏/顺序，并可按表记住布局。
- 行内编辑带 SQL 预览、应用/放弃，行新增/复制/删除。
- 底部活动日志记录表格操作，出错时包含失败 SQL 便于排查。

## 快捷键

| 快捷键 | 命令 |
| --- | --- |
| `Cmd/Ctrl+Enter` | 运行当前查询 |
| `Cmd/Ctrl+Shift+Enter` | 运行全部语句 |
| `Cmd/Ctrl+.` | 取消运行中的查询 |
| `Cmd/Ctrl+Shift+L` | 格式化 SQL |
| `Cmd/Ctrl+Shift+H` | 查询历史 |
| `Ctrl+T` | 为活动连接新建查询 |
| `Cmd/Ctrl+Option+T` | 快速切换表 |

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `sqlens.defaultRowsPerPage` | `1000` | 数据表格每页默认行数 |
| `sqlens.autoSaveQueries` | `false` | 运行前自动保存 SQL 文档 |
| `sqlens.queryTimeout` | `30` | 查询超时秒数（`0` 不超时） |
| `sqlens.autoUppercaseKeywords` | `false` | 输入时自动大写 SQL 关键字 |
| `sqlens.safeMode` | `true` | 写入查询执行前需要确认 |
| `sqlens.maxReconnectAttempts` | `3` | 最大重连次数 |
| `sqlens.idleTimeout` | `300` | 空闲连接超时秒数（`0` 永不） |
| `sqlens.codeLens` | `true` | 显示 SQL 运行 CodeLens |
| `sqlens.sharedConnections` | `true` | 在本机所有 VS Code 系 IDE 之间共享连接 |
| `sqlens.sharedConnections.storePasswords` | `true` | 将密码保存到共享配置文件 |
| `sqlens.mcp.*` | — | MCP 服务器设置，见上文 MCP 章节 |

## 安全说明

- 密码通过 VS Code SecretStorage 存储（开启共享时写入共享配置文件，文件权限为 `0600`）。
- 写入查询默认启用安全模式确认。
- 执行生成的 SQL 前，请先检查内容。
- MCP 服务器仅监听本地并有令牌保护；除非需要 AI 写入，建议保持 `readOnly` 开启。

## 开发

```bash
npm install && (cd webview-ui && npm install)
npm run build        # 构建扩展 + webview
npm run compile:tests
npm run package      # 生成 .vsix
```

## 支持作者

Sqlens 完全免费开源。如果它帮你节省了时间，欢迎到[爱发电](https://afdian.com)为我发电：

![爱发电 · 为我发电](media/Evan.jpeg)

## 许可证

[MIT](./LICENSE)
