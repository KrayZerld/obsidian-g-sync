# g-Sync (`obsidian-g-sync`)

> **Version**: `0.2.0` · **Min Obsidian**: `1.11.0+` · **Platform**: Obsidian Desktop Only · **Author**: KrayZerld & Geminyan

一款面向 Obsidian 桌面端的轻量级 Google Drive 双向增量同步插件：纯客户端直连 **Google Drive API v3**（无任何自建中转服务器），采用用户自有（BYO）Google OAuth 2.0 凭据与基于「本地 / 远端 / 基线」的三向比对算法，专注于 Vault 内 Markdown（`.md`）文档的高可靠增量同步、零数据静默丢失与全链路可观测性。

---

## 核心特性

- **纯客户端 BYO Google OAuth 2.0 授权**
  - 使用用户自有 Google Cloud **桌面应用（Desktop app）** OAuth 凭据，本地随机端口 `http://127.0.0.1:<port>/callback` 回环监听，内置 `state` 防 CSRF 校验、PKCE（`S256`）与 3 分钟自动超时回收。
  - Access Token 距离过期不足 2 分钟时自动静默刷新；遇到 `401` 自动刷新一次并重放请求；遇到 `invalid_grant` 自动标记授权失效并提醒重新登录。
  - 全部网络请求统一走 Obsidian 内置 `requestUrl`，规避 CORS 限制并自动继承系统代理。
- **三向比对与多触发双向增量同步**
  - 基于 **Local / Remote / Baseline** 三向比对决策矩阵，精准区分新增、修改、删除、双删与删改互斥（**保护优先**：一端修改另一端删除时自动保留修改并重新同步）。
  - 字节级 MD5 校验（通过 `readBinary` / `modifyBinary` 避免跨平台换行符导致的哈希漂移），原生支持 0 字节空文件；单文件超过 `5MB` 自动切换 Google Drive Resumable Upload 分块上传。
  - 支持 **启动同步**（`onLayoutReady`）、**定时同步**（1–1440 分钟可配）、**保存防抖同步**（监听 `.md` 的 `create` / `modify` / `delete` / `rename`，内置插件自触发事件抑制窗口杜绝死循环）以及 **手动同步**（设置页按钮 & 命令面板 `g-Sync: 立即同步`）。
  - 全局 `isSyncing` 互斥锁 + `pendingSync` 并发合并，中途失败时已成功文件按断点落盘至基线，避免重复传输；遇到 `429` / `5xx` 自动执行指数退避重试（`1s / 2s / 4s`，最多 3 次）。
- **零意外丢失的冲突保留与无损初始化**
  - **首次同步 / 重置基线后**：进入无损合并模式，绝不执行任何本地或云端删除。
  - **冲突安全保留**：双端同时修改同一文件且 MD5 不一致时，本地修改另存为 `<原文件名>.conflict-<设备名>-<YYYYMMDD-HHmmss>.md`（同秒重名自动追加 `-1` / `-2`），远端内容覆盖原路径，并在本轮立即上传冲突副本与更新双路径基线，同时弹出 `Notice` 提醒手动合并。
  - **安全删除**：远端删除传导至本地时调用 Obsidian 原生 `fileManager.trashFile()` 遵循用户回收站偏好；本地删除传导至云端时仅移入 Google Drive 回收站（Trash），绝不硬删除。
- **灵活的仓库路径、`.obsidian` 配置同步与忽略规则**
  - **云端仓库**支持单层或多级路径（如 `Obsidian-Vault` 或 `Backups/Obsidian-Vault`），自动逐级查找/创建；修改路径保存后自动解绑旧 `folderId` 并清空旧基线，防止误删。
  - **可选同步 `.obsidian` 配置目录**（`Sync` 页开关，默认关闭）：开启后随启动/定时/手动/笔记保存同步顺带同步核心配置、外观主题、CSS 片段及第三方插件，同时强制硬排除 `workspace.json`、`workspace-mobile.json` 与本插件设备专属文件（`local.json`、`baseline.json`、`logs.json`）；下载到新版 `obsidian-g-sync/data.json` 时自动热重载共享配置且绝不覆盖本机「设备名称」与 OAuth 授权状态。
  - 支持类 `.gitignore` 的多行通配符 / Glob 忽略规则（支持 `*`、`**`、`?`、目录 `/`、`#` 注释与 `!` 否定规则）；新增忽略规则或关闭 `.obsidian` 同步开关均同时作用于 Local / Remote / Baseline，仅解除追踪而不删除已有文件。
- **状态栏可观测性与原生 1.11+ 设置界面**
  - 右下角状态栏常驻无背景 SVG **"G"** 图标：空闲默认弱化色（hover 显示 `Synced` / `Ready`）、同步中呼吸闪烁（hover 显示 `Syncing: <阶段>`）、未授权或异常标红提示（hover 显示 `Unauthorized` / `Error: <原因>`）；点击图标或运行命令 `g-Sync: 打开同步日志` 直达设置页 `Log` 标签页。
  - 日志列表顶部精简为 `XXX/200` 与纯图标操作按钮；每条记录表头以 SVG 图标 + 数字展示（`↑1 | ↓1 | 🗑0 | ⚠0`），明细行自动缩短深层路径（`.../02/note.md`，hover 可看全路径）并统一简写为 `Upload` / `Download` / `Delete` / `Conflict: ...` / `Error: ...`。
  - 设置页遵循 Obsidian 1.11+ 原生控件体系（`Setting.setHeading()` 连体分组卡片、`addExtraButton()`、内置 Lucide `setIcon()` 图标、`Modal.setTitle()` 与 `.modal-button-container`）及左对齐下划线 4 Tab（`Auth` / `Sync` / `Ignore` / `Log`）：`Ignore` 页通过 Item List 统一展示可删除的自定义忽略路径与仅带锁图标不可移除的内置忽略路径，右上角 `+` 号打开默认从 Vault 根目录开始补全的路径选择弹窗；切换 Tab 保留未保存草稿与行内校验提示；自动同步成功静默无打扰，仅在出错、冲突或手动同步时弹 `Notice`。

---

## 安装与部署（手动安装）

> 最低支持 **Obsidian 1.11.0**（桌面端）。

1. 在本地执行构建（或获取已构建产物），准备好以下 3 个文件：
   - `manifest.json`
   - `main.js`
   - `styles.css`
2. 在你的 Obsidian Vault 目录下创建插件目录：
   ```text
   <YourVault>/.obsidian/plugins/obsidian-g-sync/
   ```
3. 将上述 3 个文件复制到该目录中。
4. 打开 Obsidian → **设置 → 第三方插件**，刷新插件列表并启用 **g-Sync**。

---

## 创建 Google OAuth 2.0 凭据

插件采用纯客户端 BYO 凭据模式，首次使用前需在 [Google Cloud Console](https://console.cloud.google.com/) 免费创建一个「桌面应用」OAuth 2.0 客户端：

1. **新建项目**：打开 Google Cloud Console，新建并切换到一个项目（如 `obsidian-g-sync`）。
2. **启用 Google Drive API**：进入 **API 和服务（APIs & Services）→ 库（Library）**，搜索并启用 **Google Drive API**。
3. **配置 OAuth 同意屏幕（Google Auth Platform）**：
   - 进入 **Google Auth Platform → 概览（Overview）→ 开始使用（Get Started）**（旧版路径：**API 和服务 → OAuth 同意屏幕**）。
   - 应用名称填写 `Obsidian g-Sync`，受众群体选择 **外部（External）** 并完成创建。
   - 在 **受众群体（Audience）→ 测试用户（Test users）** 中添加你用于同步的 Gmail 地址。
   - > **提示**：应用保持「测试中（Testing）」状态时，Google 会在 **7 天后令 `refresh_token` 过期**（需重新授权）。如需长期免重新登录，可在「受众群体」页点击 **发布应用（Publish App）**（个人自用无需提交 Google 审核；首次授权时在浏览器警告页点击 **高级 → 转至 Obsidian g-Sync（不安全）** 即可）。
4. **创建桌面应用凭据**：
   - 进入 **Google Auth Platform → 客户端（Clients）→ + 创建客户端（Create Client）**。
   - **应用类型务必选择 `桌面应用（Desktop app）`**（无需手动配置重定向 URI，原生放行 `127.0.0.1` 随机端口回调）。
   - 创建完成后复制 **客户端 ID（Client ID）** 与 **客户端密钥（Client Secret）**。

---

## 快速上手

1. 打开 **设置 → g-Sync → `Auth`**：
   - 填入 **Google OAuth Client ID**、**Google OAuth Client Secret**（支持右侧眼睛图标切换明文/密文）；
   - 填写 **云端仓库**（例如 `Obsidian-Vault` 或 `Backups/Obsidian-Vault`）；
   - 确认 **设备名称**（用于日志与冲突副本标识，仅允许字母、数字、`-`、`_`）；
   - 点击 **授权登录**，在浏览器完成 Google 账号授权。
2. 切换到 **`Sync`** / **`Ignore`** 标签页：
   - 在 `Sync` 页按需调整 **启动同步**（默认开启）、**同步 `.obsidian` 配置目录**（默认关闭）、**定时同步**（默认 `5` 分钟，`0` 关闭）与 **保存同步**（默认 `10` 秒，`0` 关闭）；
   - 在 `Ignore` 页查看内置不可移除忽略清单，并可通过右上角 `+` 按钮从 Vault 根目录选择或输入需要忽略的路径与通配符；
   - 点击 **立即同步** 执行首次无损合并并建立同步基线。
3. 切换到 **`Log`** 标签页（或直接点击右下角状态栏 **"G"** 图标）：
   - 按时间倒序查看最近 200 条同步记录，点击任意一条可展开文件级明细与错误原因；
   - 怀疑基线状态异常时，可点击顶部 **重置基线**（二次确认后清空本地快照，下次同步按无损合并模式重建）。

---

## 本地状态持久化

为避免频繁同步写入污染用户笔记，并支持在开启 `.obsidian` 同步时隔离本机专属状态，插件在 `.obsidian/plugins/obsidian-g-sync/` 下按关注点拆分存储 4 个 JSON 文件：

| 文件名 | 随 `.obsidian` 同步 | 用途说明 |
| :--- | :---: | :--- |
| `data.json` | 是 | 跨设备共享配置（Client ID / Secret、云端仓库路径、定时/防抖/忽略规则、`.obsidian` 同步开关，通过 `loadData()` / `saveData()` 管理） |
| `local.json` | **否（强制排除）** | 本机专属状态（**设备名称**、OAuth 授权状态与 Token、已绑定云端仓库 `folderId`；旧版 `data.json` 中的对应字段会自动无感迁移至此） |
| `baseline.json` | **否（强制排除）** | 本机同步基线快照（记录每个已同步文件的 `fileId`、字节级 `md5`、本地/远端修改时间与文件大小） |
| `logs.json` | **否（强制排除）** | 本机最近 200 条同步历史日志与文件级变更明细 |

---

## 更新日志

### `0.2.0`
- **新增**：支持可选同步 `.obsidian` 配置目录（`Sync` 页开关，默认关闭；同步核心配置、外观主题、CSS 片段及第三方插件，强制硬排除 `workspace.json`、`workspace-mobile.json` 与本插件本机文件，远端更新 `obsidian-g-sync/data.json` 时自动热重载共享配置）。
- **新增**：本机专属状态拆分存储至 `local.json`（含**设备名称**与 OAuth 授权状态/Token，强制不同步；旧版 `data.json` 数据自动无感迁移）。
- **新增**：将忽略规则从 `Sync` Tab 拆分为独立 **`Ignore` Tab**（`Auth | Sync | Ignore | Log`），通过单卡片 Item List 展示可删除自定义路径与不可移除内置锁图标路径，右上角 `+` 按钮打开默认从 Vault 根目录开始补全的路径选择弹窗（支持文件夹、文件与通配符）。
- **优化**：同步日志界面与状态栏极简化改造（计数改 `XXX/200`、顶栏纯图标按钮、表头 `↑ | ↓ | 🗑 | ⚠` 图标计数、触发徽章英文简写、深层路径缩略为 `.../上级目录/文件名`、明细描述精简为 `Upload / Download / Delete / Conflict / Error`、状态栏 Hover 文案统一为 `Synced / Ready / Syncing: ... / Unauthorized / Error: ...`）。
- **重构**：全量前端控件 Obsidian 原生化（统一改用 Lucide `setIcon()`、`Setting.setHeading()`、`Setting.addExtraButton()`、状态栏 `.mod-clickable`、`Modal.setTitle()` + `.modal-button-container` 以及原生语义色彩变量）。

### `0.1.0`
- **首个可用版本**：
  - 实现纯客户端 BYO Google OAuth 2.0 桌面回环授权（PKCE `S256` + `state` + 3 分钟超时 + 2 分钟预刷新 + `invalid_grant` 处理）。
  - 实现 Google Drive API v3 客户端（多级云端仓库目录解析/创建、同名目录/同名 `.md` 安全优选与告警、`>5MB` 自动切换 Resumable Upload、429/5xx 指数退避重试与 401 单次刷新重放）。
  - 实现 12 场景三向比对决策引擎、首次/重置基线 4 场景无损合并、冲突副本保留与即时上传、忽略规则过滤与基线保护、`isSyncing`/`pendingSync` 并发互斥及自触发事件屏蔽。
  - 实现状态栏 `"G"` 三态呼吸图标、Obsidian 1.11+ `Auth / Sync / Log` 三标签设置页、可折叠同步日志列表与命令面板快捷指令。
  - 完成 6 组 Vitest 单元测试套件（24 条用例全量通过）。

---

## 本地开发

```bash
# 安装依赖
npm install

# 开发监听构建
npm run dev

# 类型检查
npm run typecheck

# 运行单元测试
npm test

# 生产构建（输出 main.js）
npm run build
```

---

## License / Credits

MIT License · Created by **KrayZerld & Geminyan**.
