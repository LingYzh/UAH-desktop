# 原始日志设置与存储维护

用户已明确选择：关闭额外请求/响应原始日志时，聊天记录、过滤后的请求上下文、文件快照与必要原生续接历史继续保存。默认开启；在会话日志中的全局开关修改，从下一次模型请求尝试或连接测试生效，进行中的请求保持开始时的策略。不会回填或删除历史记录。

关闭时 RequestSnapshot 保留身份但 body=null/bodyCapture=disabled，不保存 provider.frame/SSE 原始帧；最低审批、dispatch、结果、用量等事实照常记录。captureCoverage=partial 与 continuationCoverage=native 可以并存；只有明确关闭原始捕获且必要原生历史完整时允许该组合，普通脱敏缺失不能借此放宽续接。

设置由 runtime 持有，JSON 原子写入并检查版本；独立 initialized 见证防止跨重启丢失设置文件后静默恢复开启。损坏、链接或缺失已初始化设置均明确失败。如果外部同时删除设置和见证，则与全新数据目录无法区分，不宣称可防管理员重置。

## UI 复用与验收

root 已核对 D:/UI 的 index.ts、UiSwitch/API/FeedbackDemo，以及既有 UiDialog、UiButton、UiTable、UiAlert。复用 0.2.1 的真实组件及已存在布局工具类，无通用组件缺口、不新增业务 CSS。原始日志开关浅色 1440、深色 900×800/125% 截图已由 root 验收：`artifacts/journal-policy-desktop-OzY2qr`，20 项桌面检查、本地 HTTP 5 次、页面和控制台错误为空。关闭过渡/Git 探测的等待修正在测试中完成，未改产品行为。

原始捕获专项 14/14：非 legacy 的 canonical manifest 反复投影/重启仍 partial/native；正常脱敏仍 unavailable；真实 Supervisor 三次本地请求包含跨重启 opaque 续接，SSE 专有调试字段未落盘。设置专项 9 通过、1 文件 symlink 权限跳过，hardlink/目录/损坏见证拒绝均实测。全量检查点 660 通过、1 跳过（`harness-policy-full-final.log`），最后追加的见证损坏测试及后续维护改动将在下一次全量纳入。

## 引用清理范围

新增清理入口先检查再确认，限定空闲会话内超过 24 小时的内容寻址孤立文件。复用离线导出的完整引用闭包与字节/数量上限；未知事件、legacy、丢失引用、滞后/失败日志、投影独有引用均拒绝清理。确认绑定 manifest、引用闭包、文件身份和内容哈希，变更后要求重新检查；删除中途失败报告实际完成数，不伪装全部成功。未知文件、临时文件、SQLite、canonical 事件、计划目录、命令 spool、外部导出及工作目录均不属于该入口。

此入口不按年龄删除仍有引用的历史，也不等于彻底删除会话。GC 已完成真实桌面检查（journal-gc-desktop-5F1ujm，15 项），引用分片受保护，超过 24 小时的未引用分片可清理。独立的完整会话删除、升级一致性备份及事件分片轮转也已接入；生命周期、故障恢复及证据见 [HARNESS-MAINTENANCE.md](HARNESS-MAINTENANCE.md)。
