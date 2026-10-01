# 日志、备份与会话维护

2026-10-02。以下操作仅属于宿主界面与本地存储维护，不作为模型工具暴露，不扩大 Agent 权限。UI 固定复用 @lingyzh/ui 0.2.1 的 Dialog、Button、Table、Alert、Field、Textarea、Switch 和既有布局类；无新增共享视觉能力或业务 CSS。root 已检查 UI API/demo，并验收浅深主题、窄窗及 125% 截图。

## 清理孤立文件

会话日志提供“检查 → 确认”入口。只有空闲且日志健康、引用完整的会话可检查。扫描 artifacts、restricted、segments 中已知内容寻址文件；文件内容 hash 必须与文件名一致，创建/修改时间均超过 24 小时。引用闭包递归包含公开/受限 artifact 及 manifest 分片。未识别文件、临时文件、仍有引用的事实和工作目录不删除。

确认绑定 manifest、引用闭包、候选 inode/时间/大小/hash。删除前重新核对全部候选，漂移要求重新检查；中途删除失败报告实际完成数与剩余数。链接、硬链接、路径越界、未知事件、legacy、不完整引用及超限均拒绝。没有按年龄淘汰有效历史，也没有后台自动删除。

桌面 `artifacts/journal-gc-desktop-5F1ujm`：15 项，真实两份旧孤立文件删除，canonical/manifest/引用原件字节不变、无新 HTTP。分片离线专项另验证引用分片保留、旧孤立分片删除。

## 升级前一致性备份

生产 runtime worker 在打开旧主账本和 application journal 的写路径之前，用 SQLite backup API 创建一致性备份，包含活跃 WAL 内容与隐式 rowid；不直接复制主文件。当前版本跳过，未来版本在任何写 PRAGMA 前拒绝。非空且无版本的数据库要求单独迁移，不猜测来源。

备份先写受控 upgrade-backups 下唯一 .pending 文件，校验身份、schema、quick_check，再在备份自身归一为 DELETE journal、关闭、fsync、rename 为 .sqlite。失败保留未完成标识，不当作成功备份；启动进度刷新 runtime readiness 超时。源数据库不为备份而 checkpoint 或改写。直接程序化创建 RuntimeStore 的测试/工具入口不隐式执行异步备份。

schema 3 及新增索引同事务；session_purges 为兼容追加表。迁移真实 DDL 碰撞回滚，旧 Plan 版本、审批、文件快照和消息投影保持。备份专项 9/9，迁移专项 7/7，覆盖 v1/v2、WAL、未来版本、失败和隔离恢复。恢复备份是人工操作：先停止应用，保留当前数据；恢复将丢弃备份之后的新记录，不自动覆盖或自动降级。旧客户端是否能理解新事件/分片不能仅凭 schema 号推断。

## 永久删除会话

独立于删除回复及原始日志开关。用户检查删除范围后必须精确输入“永久删除”；确认指纹漂移、任何活动运行/计划编辑、记录失败、未核实命令树退出或输出排空均拒绝。不会依据 PID 或进程名猜测退出。

SQLite 先以事务删除目标会话关联行并保存持久 purge intent；随后关闭目标浏览器、等待真实 destroyed，清除其连接、storage、认证缓存与缓存，再删除受控会话日志、artifact、计划目录及已确认命令 spool。受控完整升级备份只删除该会话行，保留其他会话；受控未完成备份按检查清单删除，界面明确其可能包含其他数据。原工作目录文件、独立分支及外部导出保留。

删除按检查时的路径/文件身份/hash 清单执行；不递归扫掉后来出现的未知文件。备份不支持、损坏、占用或文件漂移会留下持久待处理状态，界面显示并允许明确重试。重启不自动完成破坏性操作，也不恢复已经删掉的会话或重放工具。缓存与 renderer 草稿/迟到响应同步失效。单实例锁阻止同一桌面数据目录的第二个应用写入，不同数据目录可独立运行。

数据库使用 secure_delete 与 WAL checkpoint，浏览器使用 Electron 清理 API；这不是 SSD、操作系统备份或第三方副本的物理不可恢复保证。

验证：store/files/loop 共 31/31；`browser-purge-bgMXdB` 7 项，真实 cookies/storage/cache、beforeunload、迟到 loadURL 和故障重试；`session-purge-desktop-7HsQ7D` 23 项，键盘输入、分支保留、真实清理故障跨重启重试、单实例、原文件保留，删除没有新 HTTP。root 验收浅色 1440 与深色 900×800/125% 截图。

## 事件分片轮转

TranscriptWriter 默认阈值 8 MiB，按完整事件行封闭 segments/first-last-sha256.jsonl，transcript.jsonl 仅留活动尾部，可为空。单个超大事件不拆行。manifest schema 仍为 1，segments 连续、retainedRanges 保留 1..durableSeq；SQLite 是唯一事实来源，eventId 不变。

只在 manifest 原子写成功后接受轮转缓存。分片 fsync、tail 或 manifest 写入失败会报告 degraded 并使缓存失效；下一次从 canonical 重建。缺片/签名变化触发重建，显式校验核对 hash，链接拒绝。启动或投影损坏可能扫描完整 canonical 并先重建平铺文件，不宣称零成本恢复。旧未引用分片不自动删除，之后可通过上述 GC 检查清理。

离线 validate/stats/trace/replay 支持分片；full/share 导出固定水位的平铺包，兼容原平铺阅读路径。10 项轮转测试覆盖增量、重启、多轮父子、半尾、缺片、篡改、fsync/rename 故障、超大 UTF-8 行、空尾、引用保留和忘记会话；8 项离线分片测试覆盖合并等价、损坏、全局限额、full/share 与 GC。

## 仍有的边界

独立 CLI 与外部进程没有跨进程文件租约；外部恶意路径替换不属于操作系统沙箱保证。历史配额拒绝新写入不等于自动裁剪；全历史面板、继承消息、大依赖树仍可能较大。没有 PTY、未知副作用自动重放、真实 Provider 效率评测或 D09 原生运行时新增接入。以上不影响已完成维护路径，但不能包装成这些能力已经实现。
