# API 上下文引擎 V2

2026-10-04 实施、2026-10-05 更新。原方案见 [UAH_Context_Engineering_V2_Plan_2026-10-04.md](UAH_Context_Engineering_V2_Plan_2026-10-04.md)。本实现接入 UAH API 运行时；原生 Codex 继续管理自己的提示词与上下文。未引入可选 C09/pi-ai，也未新增记忆管理 UI。

## 实际请求与稳定前缀

`prompt-assembler.ts` 的 V2 分支保留稳定基座、角色、当前权限和工具说明。Git、项目规则、记忆索引、来源目录、环境与模式转换作为历史尾部的带作用域快照；每次请求前读取真实状态，仅语义变化才追加。旧快照不重写，A→B→A 会追加第二个 A，来源消失显式清空。Git capturedAt、规则 mtime、诊断 warnings、runId、累计预算、工具进度不再扰动默认系统头。来源 warnings 仍保留在脱敏请求 manifest 中。

用户自定义动态槽位保留原渲染，记录 `legacy_dynamic_template`，因此这类自定义指令仍可能改变头部。权限、工具或用户指令真正变化会更新策略版本／epoch，不以缓存为由保留过期权限。工具声明按稳定顺序生成。

`prepareAgentRequest` 一次编译并冻结三协议的 body、serialized、路由与缓存计划。admission、manifest、请求预览、observer 和网络使用同一份 prepared request；没有新输入的重试沿用它。新 steering 建立新逻辑请求。`context.request` 记录顺序段 hash、字节长度、最早差异、append-only、epoch、cache plan 和估算置信度。它是本地字节／语义证据，不能当作服务端 tokenizer 或实际缓存写入证明。

## 历史与兼容回放

SQLite schema 4 新增不可变 `context_entries` 与 owner 范围的 `context_surfaces`。根会话 owner 为 `primary`，子运行各用 `child:<runId>`，即使共享 sessionId 也不混用历史。surface revision 使用 CAS，与既有 journal/outbox 同事务提交；JSONL 仍是导出而不是另一事实源。内容存入现有受保护 artifact，surface 保存有序引用、epoch、快照 hash、指令／工具 hash 与来源 fingerprint。

普通用户回合与重启复用 surface，不重新拼接全部公开历史。编辑、删除、历史窗口或 branch 内容变化使旧投影失效。分支 native frame 保存公开祖先 digest，完整匹配才恢复 checkpoint continuation，避免压缩后又载入原始大窗口。

native replay 域由端点身份、实际地址、密钥派生 HMAC、协议、模型与序列化版本确定；端点显示名或无关 revision 不使其失效。同域保留原生签名／加密推理；跨域转换 portable history，只保留可见文本和配对工具事实，并稳定映射调用 ID。缺失、脱敏、未知 block、悬空或重复调用不能假称完整回放，走明确回退。原始 artifacts 仍可用于审计。

## 缓存与统计

只为明确的官方 endpoint/protocol/model 组合启用缓存 profile。DeepSeek 使用隐式缓存；Anthropic 与受支持的官方 OpenAI Responses 使用合法 block 标记，保留校验通过的旧 frontier 并增加新候选点。写入断点上限和回看窗口分别记录。未提供用户 TTL 配置，不擅自启用长 TTL。公司及其他未知网关不发送猜测的 cache 字段。

usage 正规化区分 input、cache read、cache write、uncached、output 与 reasoning，保存来源路径和冲突诊断。DeepSeek 标准／专有字段不相加；Anthropic 分量按其 schema 合计；流式累计快照更新而不重复累加。缺失保持 null，coverage 为 partial/unknown，不补零。

上下文弹窗按会话展示，不再逐回合选择。当前窗口取最新根请求，与会话累计计费量分开：累计用量来自全部 session attempts（包含子任务、摘要与重试），按 requestId/attemptId 去重，使用最终 revision，命中率为累计缓存读取除以累计输入。缺失或冲突字段保持未知，可显示已上报部分，不按零计入完整命中率。查询只读取 accounting journal 事件，不载入流式正文。剩余容量同时扣除输入估算、输出／工具／误差预留；未知容量不生成剩余分类。`@lingyzh/ui` 0.2.3 的 remaining 语义使用冷灰色，区分绿色消息分类；UI 库先完成 demo、视觉验收及正式发布，再升级 UAH。

## 计量与压缩

计量针对完整 prepared JSON，包括工具、协议结构与 opaque 数据。默认使用保守 token 估算；服务端输入用量有效且合理时，记录 header 和完整历史前缀 hash，以已报告输入加后续增量估算校准。头部变化、前缀修改、跨路由回放或压缩使基准失效，不把缓存率当作容量依据。独立本地请求体上限为 8,000,000 bytes，这是序列化／内存保护，不代表服务商已确认的限制；输出／工具／误差预留独立计算。累计任务 token 仅用于统计，不再作为停止理由；请求次数、工具次数、时间、权限和用户停止仍按既有机制处理。

接近容量时先检查可恢复的旧工具结果：只有成功、明确授权的公开产物与调用身份及原文匹配，才保留首尾和检索引用；近期尾部、错误、未知和引用冲突不剪裁。随后选取最早且完整闭合的工具交换进行摘要，选区随窗口变化（最高 2 MB），不再被固定 64 KB 限制；近期尾部按 token 预算保留，至少保护最后一项。摘要收益按选中区段衡量，必要时最多进行四次本地缩减检查。隔离摘要调用没有工具，purpose 为 `compaction`，同样记账。checkpoint 显式标为历史证据，保留原始用户目标／修订、计划、策略 hash、效果与待处理子运行、来源引用，并附完整当前快照。摘要失败、截断、工具调用、未明显缩小、steering 或 CAS 冲突不会提交候选。新窗口与 compaction committed 事件同事务生效；原件不删除。不可分割的超大输入停止并保留证据，不拆散工具配对，也不原样无限重试。

## 迁移与运维

schema 3→4 在既有 SQLite 事务中增表；旧会话首次 API 请求按现有历史导入，不自动发模型请求或重放工具。会话删除同时清除 entries/surfaces；新版本数据库不交给旧版本静默修改。

紧急暂停可在启动进程设置 `UAH_CONTEXT_V2_ENABLED=0`：新 API 请求明确失败并保留历史／导出，原生运行时不受此分支影响。移除变量再重启恢复。该开关是 fail-closed 暂停，**不是退回旧拼接器**；数据库降级需使用升级前完整备份，不能用旧二进制直接打开 schema 4。

## 验收证据与边界

- 全量 `npm test`：1026 项，1024 通过、2 跳过、0 失败；日志 `artifacts/context-v2-regression-final.log`。
- `npm run build` 与 `npm run typecheck` 通过：`artifacts/context-v2-build-final.log`、`artifacts/context-v2-typecheck-final.log`。后补暂停开关／规则 mtime 稳定性专项 17/17：`artifacts/context-v2-final-focused.log`。
- 三协议各 30 次唯一 read_file 工具调用，随后用户回合、Supervisor 重启，系统／工具 hash 稳定、历史 append-only、工具无重复：`tests/runtime/context-long-run.test.ts`。这是离线机制测试，非真实服务收益基准。
- 桌面 `tests/desktop/git-context.mjs` 通过。root 检查 `artifacts/git-context-1oHPTE/context-usage-light.png` 和 `context-usage-dark.png`：浅色 1440px、深色 900px/125%，缓存 234/1234=18.96%，剩余分类与滚动无裁切。fixture 数值不代表真实缓存收益。
- 真实端点经用户授权，各 3 次独立小请求、相同非敏感前缀、输出上限 64、无工具／用户历史。DS `deepseek-flash`（Responses）：输入 2636，缓存读取 0→2432→2432，输出 39/28/14，耗时 1062/538/895ms，coverage partial。公司 `gpt-6-luna`（Responses）：输入 2615，缓存读取 0→2612→2612，写入 2612→0→0，输出 5/5/5，耗时 4685/2429/1187ms，coverage complete。warm 输入缓存占比分别 92.26% 与 99.89%。这验证传输及 usage，不保证复杂长任务同等命中率。
- 原始脱敏数据：`artifacts/context-usage-live-probe-20261004/deepseek-run.jsonl`、`company-run.jsonl`。端点只从真实用户数据库只读快照加载，没有更改真实配置或会话。
- Windows Codex MSIX 环境会把 Roaming 路径虚拟化到自己的 LocalCache。最初看到的禁用 kiro 来自旧副本；宿主侧只读 SQLite backup 才取得用户指定 `C:/Users/AnnaC/AppData/Roaming/uah-desktop/endpoints.sqlite` 内真实 DS／公司配置。后续排查必须核对该边界。

测试映射：T01–T15、T27–T28 主要见 context-projection/engine/prepared/long-run 与 conditional-prompt-loop；T16–T26 见 context-portable、model-history-integration、agent-loop；T29–T39 见 context-prepared/cache planner（TTL 无可配置入口）；T40–T46 见 context-usage、request-journal、retry/steering 既有测试；T47–T56 见 context-prepared、compaction-loop、context-store；T57–T65 由现有工具 artifact、run-effects、recovery、delegation、privacy、raw-capture 测试及 V2 集成共同覆盖。T66 当前有 30 轮可复核机制测试，未建立生产规模 I/O 性能基线；不能把这份分组映射当作每个 T 编号均有独立专项用例。C09/T67–T68 未实施。

## 2026-10-05 增量机制与边界

- 对服务端明确的 context overflow，仅在尚无响应帧时允许一次恢复：先提交更小上下文，再发送新请求；输入没有变化、摘要失败或不可再缩小时保留错误，不原样重试。一般 400 错误不自动归为超窗。
- owner surface 复用已保存条目的 hash，避免每次重复计算旧历史。仍需遍历新传入历史和写入 surface 引用，不宣称已经实现完全增量 I/O。240 次持久化／160 次后重启的离线专项已建立计数与时间观测，不把单机时间作为性能 SLA。
- 每次桌面初始化停留新会话草稿，继承既有默认配置但不自动加载上一会话正文，也不创建空的持久化会话。用户显式选择历史后正常加载。
- 原生 harness 文件、记忆和上下文装配依旧由其自身机制负责。本增量没有新记忆 UI，也不向全局 Codex 记忆目录写入。
- 2026-10-04 的测试数据是历史基线；本次验收结果与真实长会话报告见 VALIDATION.md 最新记录。

### DSH 源码对照

本次继续参考 deepseek-ai/deepseek-harness 的本地固定快照 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`：`packages/llm/token-meter/src/projection.ts` 将累计用量、窗口压力和估算分类分开；`packages/compaction/compaction-basic/src/index.ts` 对最新持久化请求计量，并为 provider-confirmed overflow 使用独立恢复策略。UAH 采用相同的职责分离方向，保留自身 journal/CAS、权限及公开 artifact 恢复约束，没有直接替换运行时。

真实测试显示 JSON/opaque 数据的本地字符估算可能远高于 provider 输入计数，因此有效输入用量不再因与估算相差超过两倍而被拒绝。基准仍要求相同 header 与完整旧历史前缀，压缩后清除；无效计数与缺失报告不作为基准。
