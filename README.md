# 轮回战场 V3.2.6 · 专用网页端

这是一个从零编写的轻量游戏客户端，只针对 `轮回战场 重构版 V3.2.6` 角色卡，不依赖 SillyTavern。

## 启动

双击 `启动网页版.bat`。首次启动会自动安装依赖并构建，随后浏览器打开：

```text
http://127.0.0.1:4174
```

也可以在终端运行：

```powershell
npm install
npm run build
npm start
```

## 已实现

- 原样读取卡内 Character Card V3 数据；
- 41 条世界书，含关键词触发、常驻条目、EJS 与消息变量宏；
- 酒馆语义正则双管线：发送模型前 Prompt 处理与消息显示 Markdown 处理，支持 placement、深度、promptOnly、markdownOnly、trim、宏替换、启停、导入和源 JSON 编辑；
- 封面、五阶段完整建档、选项、检定和世界选择全部采用项目原生组件；开局数据库固定读取卡片指定的 V20260812 版本；
- 完整开局折扣兑换：1000 空间币预算，56 件装备、20 个道具、19 个技能、品质/分类/搜索过滤、购买结算及自定义兑换项；
- 个人商店独立目录支持卡片同款 `forge_shop` 定向刷新：等级从当前 MVU 读取，目标大类/装备槽位/数量交给大模型自主决定，玩家只提供额外要求；本地确定性规则锁定品质、价格、伤害与防御，API/当前 AIRP 预设只负责文案，结果按 `商城` 五列表及 `成员商库` 结构持久化；兼容 `/api/shop/refresh` 与 `/api/shop/forge`；
- 完整队友建档：Ⅰ/Ⅱ/Ⅲ级分别消耗 70/350/1000 空间币，基础档案写入 `stat_data.关系列表`，首轮按 NPC 规则补全战术模块；
- 人物档案可持久化保存、覆盖、加载、删除、导入和导出，保存在 IndexedDB；
- 4 个玩法脚本的数据与执行链；
- 内置 MVU JSON Patch、变量快照、ZOD 注册和事件总线；Patch 以 `stat_data` 为根，自动迁移旧版本误写在变量根层的世界、主角、任务和关系数据；
- 卡内辅助计算脚本原样运行；
- 悬浮球脚本映射为项目原生 HUD 与状态面板，不加载卡内 UI；
- API 连接配置按本地 Comic Orb 的实例管理方式实现：新增、保存、切换、删除、实例集导入导出与真实生成测试；
- 模型配置采用“基础地址 + 接口路径 + 模型列表路径”，获取后可搜索过滤和点选，同时保留手填能力；支持额外请求头/请求体 JSON；
- OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Google Gemini 四种协议及模型列表；
- SillyTavern OAI/AIRP 预设 JSON 导入、启用、删除和逐条提示词开关，采样参数与助手预填充会进入实际请求；
- AIRP 预设可用内置通用文本编辑器查看和编辑完整源 JSON，支持行号、查找替换、JSON 格式化、校验、恢复及 Ctrl+S/Ctrl+F；
- 向助手脚本提供酒馆预设 API：仓库导入、枚举、读取、切换、更新、保存、复制、重命名、删除和导出均连接 IndexedDB 预设库；
- 酒馆助手脚本 JSON 的导入、启停、删除与独立控制台；大型脚本存入 IndexedDB；
- 助手脚本支持本地文件及 URL 导入；远程 JSON、JS、MJS 会经本机代理下载，兼容存在 CORS 限制的托管地址；
- 助手脚本采用酒馆式宿主渲染：脚本上下文保持隔离，但悬浮球、样式和面板直接挂载到主页面，保留原脚本的拖动、缩放和开关行为；
- TavernHelper 消息、变量、世界书、事件、动态提示词注入、jQuery/Vue/Zod 等兼容接口；
- 内置游玩诊断黑盒：按运行、会话、回合串联启动、脚本、完整提示词、API 阶段、响应、MVU 变量前后状态和前端异常；写入前递归脱敏 API Key、Authorization、Cookie 与令牌，可跨运行导出完整会话诊断包；
- 模型调用全局排队且上游并发不超过 4；主游玩调用严格串行。生成时显示耗时、流式字数并可中止，首包或流式连续 300 秒无响应时安全取消上下游；
- 已用 `明月秋青写卡预设.json`（91 条提示词）和 `秋青A4.7.json`（约 19.5 MB）进行真实启动测试；
- 消息编辑、删除、重生成、开场 swipe；
- 多轮回本地存档、状态面板、任务面板与存档导出；
- 按功能划分的指挥中心、冒险、角色、装备、能力、任务、世界、NPC、情报与存档页面；
- 桌面端和移动端响应式界面。

API Key 与游戏存档只保存在浏览器 `localStorage`，AIRP 预设、助手脚本及诊断黑盒保存在浏览器 `IndexedDB`。黑盒包含完整提示词与回复但不保存密钥，默认只保留最近 30 次运行。本机 Node 服务只负责静态资源和 API 转发。

## 校验

```powershell
npm run check
npm run test:ui
npm run test:integrations
npm run test:protocols
npm run test:url-script
npm run test:editor-blackbox
npm run test:opening-mvu
npm run test:regex
npm run test:shop
```

`check` 校验卡内 41/12/4 资源；`test:ui` 测试基础游戏链；`test:integrations` 真实导入秋青预设和 A4.7 脚本；`test:protocols` 通过本地模拟上游校验四种 API 请求格式；`test:url-script` 校验潮汐悬浮 UI 与 Maya 商店预设导入；`test:editor-blackbox` 校验预设往返编辑和密钥脱敏；`test:opening-mvu` 校验旧档迁移、完整建档、商店、队友、档案和 Patch 根路径；`test:regex` 校验酒馆正则双管线；`test:shop` 校验 `forge_shop` 参数兼容、定向合并、数值防篡改和本地兜底。`test:opening-live` 与 `test:soak` 会使用真实 API，请留意额度。

## 目录

- `card/`：唯一支持的 V3.2.6 卡片；
- `src/runtime.js`：世界书、正则、TavernHelper/MVU/EJS 兼容运行时；
- `src/store.js`：本地轮回存档与变量快照；
- `src/library.js`：AIRP 预设与助手脚本的 IndexedDB 库；
- `src/blackbox.js`：脱敏、跨运行索引、保留策略与诊断包导出；
- `shop/engine.js`：V3.2.6 `forge_shop` 本地规则、数值锁定、目录归一化与 API 文案合并；
- `src/main.js`：游戏 UI、流式聊天和助手脚本兼容沙箱；
- `server.js`：轻量静态服务与四协议 API 代理。
# Vibe Combat（本地权威战斗）

左侧“世界 → 战术演算”进入 Vibe Combat 控制台。它使用三段式流程：正文/战斗 AI 只生成遭遇草案与策略，本地服务器使用固定种子结算，结束或正式暂停后再由正文模型融合战报。正文生成失败时会写入本地模板战报，战果和骰点不会丢失或重掷。

- “AI 识别当前遭遇”使用战术终端中单独选择的模型连接与 AIRP 预设；也可用内置文本编辑器手工建立 `EncounterDraft`。
- 纯手操逐单位停顿；半自动先预览策略及任一接管条件；全自动在本地推进到失能、安全暂停、200 回合上限或 10 回合僵局。
- 所有能力脚本在 QuickJS/WASM 能力沙箱内运行，首次使用必须完成 100 组固定种子审查并显式批准。
- 权威存档位于 `data/combat.sqlite`（SQLite WAL）；“查看重放”可读取完整哈希链，“诊断黑盒”导出会附带当前战斗重放。
- 完整设计与协议见 [docs/VIBE_COMBAT_ENGINE_V1.md](docs/VIBE_COMBAT_ENGINE_V1.md)。

战斗测试：`npm run test:combat`；浏览器战术控制台测试：`npm run test:combat-ui`。

## 许可协议

本项目采用 [CC BY-NC-SA 4.0](LICENSE) 许可协议发布：允许署名共享与改编，禁止商业用途，改编作品须以相同方式共享。

许可选择与署名方式参考自 [gemini114514 / Comic Orb](https://github.com/gemini114514/comic-orb)（同为 CC BY-NC-SA 4.0）。
