# ADR-001：Electron + Vue 3 桌面底座

状态：用户已选择。日期：2026-09-26。

## 决策

采用 Electron、Vue 3 Composition API、Vite、Pinia；稳定 IPC/运行/审批/存储核心使用 TypeScript。Windows 能力按需通过 .NET 10 helper，不同时引入 Rust。原型提供视觉与交互合同，不把全局 `S`、fixtures 或整页 `innerHTML` 封装进桌面壳。

依赖锁定于 `package-lock.json`。业务组件用 JavaScript；图标和标志复用原型 SVG，布局与字号按原型基线及 review 的可读性修复执行。

## 边界

- Renderer：Node 关闭，contextIsolation/sandbox 开启，仅暴露有限 preload 业务方法。
- Main：校验 IPC webContents/main frame/可信 URL 和命令 schema；目录来自系统选择器，不接受任意执行字符串。
- Runtime：独立 utility process；统一启动校验、配置快照、审批身份、目录租约、取消终态。切页不影响运行。
- Browser：独立 WebContentsView，无主界面 preload；HTTPS，拒绝新窗口、下载与未授权权限。每会话独立 profile，暂不提供 Agent 网站动作。
- Helper：JSON Lines 标准输入输出，只读窗口/UIA 根元素；停止经协议与实际退出确认，不按瞬时 PID/名称强杀。

依据 [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)、[utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)、[WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)。独立 utility process 不等于 Shell 文件系统沙盒。

## 数据与验收适配器

采用 Node 内置 [SQLite](https://nodejs.org/api/sqlite.html)，避免首版底座额外引入 native npm ABI 依赖。持久化会话、运行、审批、事件与内容快照，带 schema 版本及启动恢复。Pinia 是界面投影，不是执行权威。

`local-verification` 明确标注为基础验收适配器：实际流式文本、审批、独占新建文件、不可变快照、取消和重启恢复。不调用 AI、不使用凭据、不执行 Shell；**不声称完成 review 第二阶段的实际模型/官方运行时链路。**

当前同目录活动运行直接拒绝，无共享/worktree。文件写入只创建独立新文件，不修改已有业务文件。

SQLite 内的运行、审批、事件和快照在同一事务提交；新文件写入与数据库之间还没有跨资源崩溃恢复日志。普通数据库提交失败会按文件身份撤销本次新建文件，但在文件落盘与数据库提交之间强制断电或终止进程，可能留下未登记的验证文件。接入实际业务文件编辑前必须补齐 staging/manifest 与故障注入恢复验证。

## 后续门槛

1. 接实际模型/官方 CLI，按安装版本探测能力，用真实结构化事件和审批协议，不提取订阅凭据。
2. 接 OS 凭据引用、正式模型目录、备份/导入事务和存储规模策略。
3. 接 PTY/按需编辑器，专项测试嵌入浏览器模态遮挡、焦点、跨屏 DPI；授权与登录态分离。
4. 接观察代次、父会话屏幕租约与进程组生命周期后才启用动作，分别说明原生 Windows 与 WSL2 的权限语义。
5. 验证发行打包、签名、升级回滚，维护 Electron/Chromium/Node 安全更新。

确定性适配器和单屏截图不能作为上述正式集成已完成的证据。
