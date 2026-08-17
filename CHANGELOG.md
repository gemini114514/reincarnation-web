# 更新日志

## v0.1.3（2026-08-17）
- 移除 `better-sqlite3` 原生依赖：`npm install` 不再需要 Visual Studio/node-gyp 编译环境
- 战斗存档改为双后端：Node >= 22.13 使用 Node 内置 `node:sqlite`（仍写入 `data/combat.sqlite`），旧版 Node 自动回退到纯 JS 文件存档 `data/combat-store/`
- 两个后端事件哈希链与重放完全一致（`npm run test:combat` 双后端验证通过）

## v0.1.1（2026-08-17）
- 更新测试版本：验证 update 检测与自动更新流程
- 版本号升至 v0.1.1

## v0.1.0（2026-08-17）
- 版本号正式定为 v0.1
- 战术演算终端重构为五阶段引导式流程（遭遇发起→建模确认→编制部署→战场演算→结果结算）
- 初始折扣兑换与个人商店支持道具等可叠加物品数量购买
- 所有大模型进度条支持手动取消任务
- 剧情界面新增「完整 Prompt」只读查看
- 二维战场支持缩放后按住拖动平移
- BattleDeclaration / CombatModel 声明与建模可靠性修复
- 新增 `update.bat` 更新脚本、更新提示与自动更新功能
- 采用 CC BY-NC-SA 4.0 许可协议
