# UAH 双端运行时升级方案索引

日期：2026-10-01。按用户要求，最终实施方案分别保存到两个产品仓库。本文件只提供入口，不再维护一套混合的双端工作包。

- [UAH 桌面端运行时最终升级方案](./UAH-DESKTOP-HARNESS-UPGRADE-PLAN-2026-10-01.md)：桌面独立架构、SQLite 权威事件与 JSONL 投影、Windows 命令生命周期、跨轮历史、UI 库协作、D00 至 D09 工作包和验收。
- [AgentApp Android 端运行时最终升级方案](D:/StudioProjects/AgentApp/design/AGENTAPP-ANDROID-HARNESS-UPGRADE-PLAN-2026-10-01.md)：Android 独立架构、严格模型终态、新会话 journal、设备动作与生命周期、备份迁移、A00 至 A09 工作包和验收。

两份方案均可独立执行和发布。共享范围仅包括版本化事件/结果/用量语义与黄金测试样本，不共享技术栈、持久化权威或平台执行器。

两端均保留默认完整 transcript.jsonl、逐请求用量、主子代理关联、完整和脱敏导出、离线验证与回放，作为首批基础交付。方案定稿不表示代码实现、迁移或新增验收已经完成。
