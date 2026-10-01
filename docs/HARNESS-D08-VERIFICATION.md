# D08 独立人工目标验收

2026-10-02：引擎 completed 不再是目标验收的替代。最新已完成的非 Plan 主任务可打开“目标验收”，用户独立检查结果后填写实际覆盖的验收标准，宿主保存 method=user_review 的不可变证据及 goal.verified 事件。不会自动运行旧命令或额外请求模型；没有把模型答复、子代理报告或退出码0自动提升为目标通过。自动执行测试、独立模型评审不属于此人工验收入口。

核对包含会话/工作目录、运行公开事实、已记录文件版本、命令结果、退出码、产物引用及命令后是否还有副作用。现有 ResourceVersion 按 raw_bytes/utf8_text 核验，受应用内读租约和路径/链接/身份限制；最多100000事件、10000资源、1000命令，界面证据2MiB上限，超出明确拒绝。文件变化/缺失/无法核对、活动任务、未核对副作用和记录故障阻止保存通过。用户须自行检查未记录文件与外部系统，不宣称整个工作区均有自动版本覆盖。

保存前重取 fingerprint；goalVerification 投影和 canonical 事件在同一事务提交，记录失败不发成功通知。criteria 已知凭据与凭据 URL 过滤，证据引用遵循既有 artifact 完整性检查。打开记录时重新比较作用范围和资源 fingerprint：新任务、回复修订或当前文件变化使旧验收 stale；引擎状态仍可为 completed。聊天只显示“查看目标验收记录”，不缓存一个可能过期的绿色已验证状态。离线 replay 仅还原记录并标 not_checked_offline，不访问当前工作区或声称仍有效。

组件盘点沿用已验收0.2.1的UiDialog/UiButton/UiAlert/UiTable/UiField/UiTextarea，无新通用能力缺口，无共享CSS修改。root验收 goal-verification-desktop-DXkxcc 的浅色1440、深色900×800/125%，15项测试覆盖Enter提交、Escape、重启current、文件外改stale/提交入口关闭，无横向溢出或页面/控制台错误，仅2次本地HTTP和一次read_file。后端10项覆盖真实SSE、事务trigger回滚、未知dispatch、非法状态、旧指纹、full/share导出闭包及离线只读。提示词context.environment升为v5，声明人工记录未在本轮重新核对，不写回Agent配置；品牌精确迁移源未改。新增功能后的全量最终检查随捕获开关收敛后统一运行。
