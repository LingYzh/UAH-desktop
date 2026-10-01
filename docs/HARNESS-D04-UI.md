# D04 日志界面组件盘点

2026-10-01：UAH 实装 `@lingyzh/ui` 固定版本 0.2.1；检查 D:/UI/src/ui/index.ts、UiDialog/UiTable/UiCodeBlock/UiBadge/UiAlert API、TableExample、content.js 和 feedbackContent.js 真实 demo/文档。

复用 UiDialog 的固定标题/底部与正文滚动；UiTable 显示最近 100 个请求；UiBadge 表示记录健康；UiAlert 提示覆盖范围和操作错误；UiCodeBlock 查看最终请求 JSON；UiButton 负责刷新、详情、目录和导出。未知用量显示“未知”，不填零。使用库已有布局工具类，不增加业务视觉 CSS。无新增组件或通用能力缺口。

日志与请求上下文分别由独立弹窗负责。日志弹窗只通过受验证的 preload API 查询当前会话，切换会话/关闭使旧响应失效。导出路径由主进程系统目录选择器生成，renderer 不提供路径。默认分享导出移除受限块；本地完整副本明确包含代码、路径和对话，当前 capture partial 不标成完整捕获。

视觉验收待集成构建后补充；本记录仅确认可复用已有已验收组件，不代替此次界面验收。

## 2026-10-01 集成验证与视觉验收

新增 `tests/desktop/journal.mjs`，在独立 `artifacts/journal-desktop-kyypTU/data` 启动真实 Electron，使用本地 SSE 两轮 read_file 工具请求和系统目录选择器 fixture；不接触用户数据库或外部模型服务。验证两条关联请求、服务实报与未知用量、最终发送 body 对照、凭据不进入快照/导出、健康状态及持久化/导出水位、非法 IPC 拒绝、完整/分享导出离线 validate、受限原件从分享副本移除，以及取消导出。

截图共六张：浅/深主题各覆盖 1440px、900px 和 900px/125%。自动几何验证固定 footer 可见、弹窗及长行详情不越横向边界、长行在 UiCodeBlock 内部横向滚动、外层滚动壳不意外偏移；常规六种尺寸表格内容均能完整容纳，额外降低有效 viewport 后验证真实表格内部横向滚动。Escape 关闭和触发按钮焦点恢复通过。页面与控制台错误为空。

root 已直接查看同轮先行证据 `artifacts/journal-desktop-QpnDAR/journal-light-1440-100.png` 和 `journal-dark-900-125.png`，确认布局、阅读和固定 footer 接受，无需修改共享或业务样式。最终六张截图及几何报告位于 `artifacts/journal-desktop-kyypTU`；后续测试调整仅增加几何/协议断言，没有改 UI 样式。此记录完成本轮组件组合的视觉验收，不把功能断言单独等同于视觉验收。

## 同日请求尝试展示修正

root重新核对UI导出、UiTable的稳定item-value API和TableExample/tableContent真实文档。按attemptId做行键并精确选择requestId+attemptId，继续复用同一UiTable/UiButton/UiCodeBlock；无通用能力缺口，无样式或UI仓修改。详情显示请求及尝试身份，旧request-only多尝试查询拒绝歧义。

扩展真实Electron fixture覆盖HTTP503两次后成功的三个独立行，失败用量保持未知，成功用量单列，并打开失败attempt对应body。root查看artifacts/journal-desktop-CPMX7r/retry-attempts-dark-900-125.png，确认三行、尝试身份、详情与固定footer可读。另验证三次同参数非法工具批次暂停及持久中文停止理由。对应全量545/545；最终重复验证目录为artifacts/journal-desktop-uRtYCK。

2026-10-02会话范围快照接入后journal-desktop-CrNj3L67项通过。随后日志面板与离线统计共用最高usage revision归并，旧revision晚到不覆盖新值，同revision矛盾明确拒绝；请求终态不因后续用量快照退回准备中。新增journal-usage-view定向通过，合并全量579项通过，无组件/API/样式变化。
