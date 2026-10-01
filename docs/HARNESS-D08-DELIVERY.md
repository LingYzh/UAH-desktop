# D08 子结果投递检查点

2026-10-01：Supervisor 在既有 spawn_agent/wait_agents 及自动终态投递上增加 canonical `delegation.delivery` 回执。

同一待消费 child 版本只创建一个 deliveryId，resultEventId 指向该 child 已持久化的 run.state 终态。delivered 表示进入待投递队列；prepared 绑定准备发送的 attempt；收到 HTTP response 后记录 sent（无响应的网络发送仍可能不确定）；合法完整响应和原生块记录成功后才记录 consumed。失败或部分流不提前消费，不补造消费回执。父轮故障仍停止所属子任务。

agent-loop 专项23/23通过，其中父子完整等待验证四阶段共用身份且 consumed 晚于合法 response.terminal；投递后的500响应验证保留未消费事实。测试为本地 SSE，不执行外部 Provider 请求。

后续调度接入：应用内共享 ToolScheduler 提供 FIFO 读写租约，最多四个读取并行，写入独占，排队写者之后的读取不能插队。workspace 工具在审批后取得租约，再检查取消、路径和资源版本；租约保持到结果记录完成。Git 读取与 Plan 文件也使用同一调度器。父代理等待子任务不占写租约；不可变 artifact 读取不占共享文件租约。此规则协调 UAH 自身任务，不是外部程序的文件系统锁。

纯调度与真实父子循环合计13项通过，覆盖读取/写入互斥、父等待子、排队取消和记录失败。故障注入发现并修复停止状态保存失败跳过清理的问题：先取消并等待所属执行结束，再投影 recording_failed 终态；第二个排队写入未发生，队列和租约均释放。

## 运行中补充指令

`steer-run` 绑定 runId 与 expectedStepId，只接受活跃 API 根任务的当前步骤。迟到步骤、终态、子任务和 Plan 模式拒绝；Plan 仍走提交与修订流程。每轮最多16条、合计100000字符，单条最多20000字符。接受时 control.requested 与 queued 状态同事务保存，原始用户输入和旧请求事实不修改。

接受补充会使本任务待审批失效并停止所属旧子任务；已 dispatch 的当前工具先收尾，未 dispatch 的旧批工具记录 cancelled/not_started/CONTROL_SUPERSEDED，不执行。宿主在安全边界等子任务终态，事务记录 control.applied 与 applied 状态，再把原文作为 user 消息加入后续窗口；权限、工具目录和资源版本照常重取。这里 applied 表示加入上下文，不代表 Provider 已收到或确认。停止、预算耗尽及记录失败后未应用的输入仍保留 queued，重启不自动发请求或重放工具。现有副作用不会被补充指令自动撤销。

公开历史回退和分支保留补充用户消息；原生 frame 指纹覆盖补充状态。离线 replay 以 run/control ID 去重，显示 queued/applied，未知或跨 run 的 applied 不补造输入，也不会把输入文字当授权。新增两项离线回归后共26项通过。

组件盘点：复用 @lingyzh/ui@0.2.1 UiButton ghost/sm、UiMarkdown 与已有 user-message 布局；已查 UI 公开 API、ControlsDemo，无通用组件缺口，无共享 CSS 修改。桌面23项检查覆盖按钮/Enter、空输入禁用、停止可用、旧步骤拒绝时草稿保留、旧工具未写、queued/applied、无横向溢出与控制台错误。证据 `artifacts/steer-desktop-eqlqnl`。root看图验收浅色1440与深色900×800/125%，排队消息、补充按钮和停止按钮清楚可用。

重启继续停止未完任务；未消费回执保留供后续安全继续读取，不能据此自动重放写工具。2026-10-02 已增加人工核对与显式续接及持久预算恢复，详见 HARNESS-D08-RECOVERY.md。自动重启继续、跨进程重投及独立目标验证仍未实现，D08 整体尚未完成。
