# UAH Context Engineering V2：桌面端优先的上下文与缓存机制改造计划

版本：1.0  
日期：2026-10-04  
主要对象：`LingYzh/UAH-desktop` 的自有 API Runtime  
次要对象：`LingYzh/AgentApp` 的等价语义和测试向量  
交付性质：静态源码核查、架构设计与实施交接；没有修改仓库，没有运行项目测试，没有调用用户的付费模型。

## 0. 给实施代理的总指令

目标不是让 UI 显示一个更好看的缓存百分比，也不是单纯缩短 system prompt。目标是让同一会话连续请求共享的模型输入前缀保持稳定，让缓存策略真正覆盖不断增长的历史，并保证上下文可以持久恢复、按目标路由安全回放、按需压缩和逐请求解释。

请先阅读当前仓库 `AGENTS.md`、运行时/日志升级文档及子代理中途消息计划，核对 HEAD 相对本文固定基线的变化。保留已有未提交改动。按本文工作包增量实施，不重写整个 supervisor，不替换 UI 技术栈，不引入独立云服务、Redis 或消息中间件。

继续以现有 SQLite 事件与状态提交为权威，以既有 outbox / 单写入链路生成 `transcript.jsonl`。本文新增的 surface、manifest、cache frontier 都是这条权威链路的一部分或可重建投影，不能形成第二套独立可写会话历史。

先建立最终请求边界诊断和确定性回归测试，再改上下文装配；先修复系统前缀与历史连续性，再优化压缩。所有缓存阈值、TTL、断点格式和特殊消息能力都必须以实际 provider/model/endpoint 的能力配置为准。不能只根据 `anthropic` / `openai-chat` 协议名推断全套能力。

基础范围不得自动发起付费 API 测试，不得改变用户默认模型、账号、权限、数据保留政策或自动增加长 TTL 成本。真实 provider 的 A/B 验证由独立 opt-in 命令执行；普通测试和 CI 必须离线。

**完整交付是第 18 节 C00–C08 全部通过。C09 的 pi-ai 后端试接是可选分支，不是完成前述机制改造的前置条件。Android 按第 17 节另行同步，不阻塞桌面端交付。**

---

## 1. 基线、证据与问题定义

### 1.1 固定源码基线

| 项目 | 本文使用的基线 | 说明 |
|---|---|---|
| UAH-desktop | `629196a0328e66eba691a0f928a9f8536c990505`，main | 本轮重新查询并核查相关发送、预算和提示组装代码 |
| deepseek-harness | `5badb15009ae1756c3afe0ae0cef1faafc290ccc`，master | 延续上轮分析的固定快照；本轮重新读取 runtime-context 实现 |
| pi | `200387122ca450d6387f033949423114a270b96c`，main | 本轮核查该提交及 transform-messages；DSH 安装版本不必与它相同 |
| AgentApp Android | `90fa0e60a63bb12320351836b5bfde787649aeae`，master | 上轮核查基线；Android 实施前重新比较当前代码 |

DSH 的 `llm-pi-ai/package.json` 在上述快照声明 `@earendil-works/pi-ai: ^0.87.1`。这是依赖范围，不是已证明的安装版本。需要源码移植或引入依赖时，以锁文件与固定提交再核实。[S01–S04, S12]

### 1.2 事实、推断与待验证项分开

用户报告：桌面端缓存命中率低于 20%，并随对话增长下降。本文未取得该用户真实连续请求的原始遥测，因此不能把某个因素量化为“导致了百分之多少未命中”。

已经由源码确认的高风险路径：

| 编号 | 代码事实 | 影响判断 | 验证方式 |
|---|---|---|---|
| F01 | `runtimePromptContext()` 将 runId、执行状态、任务树预算和工具纠错状态放进环境上下文 | 环境里混合了每轮变化的非必要数据 | 比较连续请求的 section 和模型输入前缀 |
| F02 | `agentLoop()` 每轮读取 Git、传入 `budget.snapshot()` 并重新执行 `assemblePrompt()` | 预算含 elapsedMs / 消耗计数；即使项目未变也会改变输入 | 固定任务、仅推进时钟的离线测试 |
| F03 | assembler 最终把 context.* 与稳定规则一起 join 为 `instructions` | “动态模块排在 system 末尾”仍在整段历史之前 | 从实际 body 而非 UI 分类验证 |
| F04 | transport 把 instructions 放到 Chat 首部 system / Responses instructions / Anthropic system | F01–F03 的变化发生在历史前缀之前 | 最终请求投影 source map |
| F05 | 检查到的 Agent API body 构造路径没有主动安排 `cache_control` / `prompt_cache_*` 断点策略 | 对要求显式开启或明确断点的路径不充分；不代表所有上游都完全无缓存 | route capability + body golden tests |
| F06 | `usageEvents()` 的非 Anthropic 路径读取标准 details.cached_tokens，没有独立 DeepSeek 专有字段兜底 | 只返回专有字段的网关可能显示未知/不完整；这是统计兼容问题，不等于真实未命中 | 多种 usage fixture |
| F07 | 同源历史复用受 model、protocol、accountNamespace=`connection.id@revision`、公开消息指纹等限制 | 该隔离是有价值的；但 UI 性质的配置 revision 也可能引发不必要降级，需分离版本语义 | 分类修改端点配置的测试 |
| F08 | 上下文准入以 body bytes + 1024 为保守 token 估计；网络又有 1,000,000-byte 请求上限 | 不能当作真实 tokenizer；可能较早触发投影或暂停，也可能出现准入/发送上限不一致 | 分开 token budget 和 transport bytes |
| F09 | `publicHistoryCandidate()` 是原生旧历史到公开历史的替换，不是模型摘要 | 需要保留安全事务基础，再补可持续上下文压缩 | 跨 run 的 active surface 恢复测试 |

F01–F09 来源见 [S05–S10]。以下因素属于需要通过 trace 排查的条件分支，不应未经实测就认定发生：有限 historyTurns 的滑动丢头、原生 frame 缺失后的回退、工具集合动态变化、网关改写 system、账号轮换、TTL 到期、上游路由漂移、缓存字段缺失或分母算错。

### 1.3 为什么“越聊越低”符合前缀故障的表现

假设只剩 4,000 token 的固定头部可复用，实际输入依次为 20,000、40,000、80,000 token，则该固定部分占比分别为 20%、10%、5%。这是说明机制的假设例子，不是对用户日志的测量。

需要修复的是“能共享的历史前缀长度不再随对话增长”，而不是单独把固定 system 再压缩一半。

但还有第二种机制：即使前缀稳定，若缓存只写/读固定头部，或移动断点丢失上次已写位置，增长中的历史也未必命中。最终方案必须同时解决 **prefix stability、history continuity、cache frontier** 三件事。

---

## 2. 目标、非目标与不可破坏的边界

### 2.1 目标

1. 同一路由、同一有效策略、未压缩/编辑的普通续聊，保留上一请求共同输入前缀；只在历史尾部追加新内容。
2. 会话跨多个 run、关闭重开应用后，复用相同的上下文条目、排序、策略版本和兼容原生信息。
3. 每次请求能解释：看到了什么、内容来自哪里、为何降级、哪里最早变化、断点在哪里、用量是否完整。
4. 压缩以受控事务替换旧区间，避免每轮滑动删除或重生成旧摘要。
5. 支持现有三种桌面 API 协议的差异，不牺牲账号隔离、工具配对和恢复安全。
6. 在符合条件的长对话 warm benchmark 中显著提高真实缓存读占比；不通过填充无用 token、隐藏冷启动或漏记摘要成本达标。

### 2.2 非目标

不修改 provider 服务端缓存；不保证所有 provider 达到固定命中率；不统一所有协议为字符串聊天记录；不让 pi-agent 替换 UAH 的权限与工具循环；不无条件接入新增 provider/OAuth/模型；不新增双向子代理聊天；不改动官方 CLI 的内部上下文；不把 MCP/RAG/向量数据库作为本轮前置依赖。

### 2.3 强不变量

| ID | 不变量 |
|---|---|
| I01 | 模型可见输入可由权威记录、固定投影版本与保存的内容引用重建；无法重建时必须标明 coverage，而非伪造完整 |
| I02 | 提交后的上下文条目不可原地修改；编辑、删除、摘要和卸载通过新事件与 surface 版本表达 |
| I03 | 普通追加不改变已有条目的模型可见表达；必要协议归一化须确定性，并有解释 |
| I04 | 用户资料、工具结果、子代理报告、摘要永远不能因为类型包装而变成授权来源 |
| I05 | 工具执行仍由当前 host 权限判定；缓存、历史工具定义、模型正文都不授予权限 |
| I06 | 当前未闭合工具批次不能被上下文消息插入、拆开或默认为成功 |
| I07 | 签名、加密 reasoning、原生 ID 只能在经验证的兼容边界回放；不做同协议即可信 |
| I08 | 每次真实 HTTP 模型尝试都有 attemptId；流式累计 usage 不重复累加；缺失不填零 |
| I09 | 重试不重新追加同一用户输入、环境快照或 relay；已有副作用不因重试而重新执行 |
| I10 | 关闭应用或暂停后不得因恢复上下文、重建缓存 frontier 而自动调用模型 |
| I11 | 隐私删除/排除会使相关摘要和投影失效；不能从旧摘要或旧 frame 把内容复活 |
| I12 | JSONL 仍是既有权威提交链路的导出；不创建第二套独立会话写入系统 |

---

## 3. 从 DSH / pi 借鉴什么，明确不照搬什么

### 3.1 DSH：借鉴“日志推导上下文”的机制

`SystemPromptProjection` 根据有效路由的 `inHistory` 与 request series 决定追加系统更新还是整理系统头；未变化不写。`RuntimeContextProjection` 比较最后仍在 active surface 上的快照；没变化不追加，快照被压缩移除则允许恢复，状态清空用明确的清除快照表达。[S11]

UAH 迁移要点：

- 不再从当前 UI 或易变 RunRecord 每轮重建全部提示。
- 比较的是“当前保留且有效的快照”，不是“历史上出现过这个 hash 就永远不再发”。
- 系统指令和运行事实分别投影；真实系统规则变化不能假装成普通用户事实。
- 适配能力来自本次固定路由，不从模型昵称、品牌名或协议字段猜测。

DSH 的 LLM 约定、回放 envelope、压缩事务也作为参考，但其 Cordis 插件微内核不是 UAH 的必要依赖。[S12–S15]

### 3.2 pi：借鉴通用消息加原生保真信息的两层模型

pi 的 `transformMessages` 根据 provider、API 和 model 判断同源，处理跨模型思考块、签名以及工具调用 ID 映射；结果 ID 与调用 ID 使用同一映射。[S16]

UAH 应保留可移植的正文、工具调用和结果，将原生保真数据作为带来源和版本的附属信息。当前桌面端的账号/端点边界更严格，应保留并细化，不能退回“只要 provider + model 同名就放行”。

### 3.3 不照搬的行为

- pi 会为某些孤立工具调用生成合成结果，并跳过中止/报错的 assistant。UAH 有真实副作用与审计要求，不能在 serializer 里悄悄这样做；需要先由恢复策略记录 `not_executed` / `cancelled` / `outcome_unknown` 等事实或派生说明。未知副作用不能被包装成普通失败后继续重试。[S16]
- 不无条件把可见 reasoning 当作普通正文跨 provider 转发；采用明确的隐私与保真策略。加密/签名 reasoning 和公开推理摘要不等价。
- 不照搬大窗口模型的默认压缩预算、巨大 summary 输出 cap，或按英文长度推算中文/代码的统一常量。
- 不照搬 provider 特定 OAuth、身份伪装或客户端标识路径。本轮只讨论合法配置的已有 API 连接。
- 不把某个 pi 版本的发送字段视作最新 provider 文档的永久替代。缓存协议仍需版本化测试。

### 3.4 是否直接安装 pi-ai

本计划选择：**先实现 UAH-owned Context Engine，provider 适配边界兼容后再评估 pi-ai。**

桌面端继续拥有任务树、权限、工具、SQLite、transcript、预算和恢复。pi-ai 至多作为可选 protocol backend，不能成为会话唯一事实源。

原因：单独换 SDK 不能消除 UAH 已在系统提示里插入的 runId / elapsedMs，也不能修复跨 run 重建历史。直接换库还可能改变重试、usage、签名和工具错误语义。C09 必须通过同一套 conformance tests；没有对齐就保留现有 native backend。[S05–S08, S16]

---

## 4. 目标架构

```text
权威会话事件 / 工具结果 / 控制事件 / 用户输入
                    │
                    ▼
       ContextSurface：当前有效上下文投影
       （不可变条目引用 + 版本 + 压缩覆盖范围）
                    │
                    ▼
       RouteSnapshot：固定实际 provider / model
       协议、认证域、能力、默认参数、投影版本
                    │
                    ▼
       ContextPlanner：稳定策略 + 变化快照
       + 当前 surface + 完整工具批次 + 附件决策
                    │
                    ▼
       ContextCompiler：确定性协议转换、回放校验
       工具 ID 映射、输入计量、source map
                    │
                    ▼
       CachePlanner：稳定锚点 + 历史 frontier
       + 本次推进点；按路由安排合法缓存控制
                    │
                    ▼
       PreparedRequest：冻结的最终 body 与清单
       admission / usage purpose / input fingerprints
                    │
                    ▼
       SQLite 提交请求准备记录 → 实际 transport
                    │
                    ▼
       流式结果 → 合法终态 → 持久 assistant / tools
       → usage settlement / frontier evidence / outbox
```

图中是逻辑职责，不要求照图创建同等数量的服务类。可以合并为少量纯函数和一个受控 coordinator。不得把它实现成多个可以各自修改历史的 middleware 链。

### 4.1 三种数据必须分开

**事实日志**：真实发生的输入、输出、工具动作、用户编辑、控制与压缩事件。

**模型可见 surface**：当前被选入的历史，可能包含摘要、卸载描述和必要状态；不是全部日志。

**协议 wire request**：当前路由实际收到的字段、分组、原生块和缓存控制。

UI transcript、可见上下文预览、实际请求清单都从相同来源投影，不能互相逆向充当唯一源。

### 4.2 会话级上下文，不是 run 级上下文

`runId` 仍用于调度与审计，但不作为普通续聊的缓存谱系。一次用户提问通常创建一个新 run，不能据此重建整段历史和系统提示。

新 run 应接入同一 branch 的 active surface。需要任务特有背景时，在尾部新增条目。重启只恢复保存的投影，不因为进程实例变化就更新模型可见头部。

---

## 5. 数据契约与版本语义

以下为建议形状，不是要求直接复制的已实现接口。字段可以与当前 contracts 合并，避免重复实体。

### 5.1 CanonicalEntry

```ts
interface CanonicalEntry {
    id: string;
    sessionId: string;
    branchId: string;
    sourceEventIds: readonly string[];
    kind: 'user_input' | 'assistant' | 'tool_result'
        | 'runtime_snapshot' | 'policy_update' | 'relay'
        | 'summary' | 'attachment_projection' | 'recovery_notice';
    contentRef: string;
    contentHash: string;
    schemaVersion: number;
    exchangeId?: string;
    source: {
        actor: 'user' | 'model' | 'host' | 'tool' | 'subagent';
        runId?: string;
        modelOriginRef?: string;
    };
    replayRef?: string;
}
```

角色不是该接口上的随意字符串。应使用区分联合或各 kind 的独立 payload：assistant 允许有序内容块，tool_result 必须有关联调用和事实状态，policy_update 只能由 host 控制面创建。provider 编码时再产生合法角色。

`createdAt`、runId、requestId 等审计字段不自动序列化进模型内容。模型需要执行引用时，可将稳定 execution / artifact ID 明确作为内容的一部分保存一次；不能机械删除所有 ID。

### 5.2 ContextSurface

保存：surfaceId、branchId、revision、ordered entry refs、instructionSetVersion、toolManifestVersion、compaction generation、有效运行快照引用、覆盖/排除范围、恢复 coverage。

普通追加应仅更新尾部和 revision。区间替换产生新 surface 版本，旧日志保留到现有数据保留/删除政策规定的时间；不是无条件永久保留。

需要支持长期单个用户任务中的压缩：切分最小单位是完整 exchange / 已闭合工具批次，不是“整个 run 永不可压缩”。尚未完成的批次与不可丢失的副作用证据必须保护。

### 5.3 版本不能混用

| 字段 | 什么会改变它 | 什么不应改变它 |
|---|---|---|
| contextRevision | 追加消息、明确投影变更 | 仅查看 UI |
| instructionSetVersion | 有效 host / Agent 指令或模板行为变化 | elapsedMs、token 消耗、runId |
| toolManifestVersion | 有效声明集合、Schema、必要描述变化 | 工具执行先后或 UI 排序 |
| routeSnapshotId | 端点、模型、认证域、协议/能力/实际参数快照变化 | 请求过程中热更新不能改旧快照 |
| replayDomainVersion | 影响原生回放兼容性或认证隔离的事实变化 | 端点显示名、图标等纯展示字段 |
| contextEpoch | 需要有意重编译/改写已有模型输入的边界 | 普通续聊、新 run、正常重试、应用重启 |
| cacheFrontierVersion | 本地缓存候选边界及服务端证据更新 | 不代表服务端缓存已被操作或清空 |

`contextEpoch` 是本地解释标识，不是给 provider 的强制 flush 指令。不能把每次 contextRevision、最新内容 hash 或随机 requestId 放进远端 cache key，导致每次请求换桶。

### 5.4 RouteSnapshot

固定：provider route ID、规范化端点、请求模型 ID、协议、credential scope 引用、capability version、adapter/serializer version、有效参数、缓存 profile 和隐私政策。

请求开始后配置变化只影响下一次请求。签名/加密回放域不得跟着可编辑显示名改变。凭据原文仅在受控认证路径使用，不能写入 manifest、hash 调试输出或 cache key。

### 5.5 PreparedRequest / RequestManifest

```ts
interface RequestManifest {
    schemaVersion: number;
    requestId: string;
    attemptId: string;
    purpose: 'agent' | 'subagent' | 'compaction' | 'title' | 'other';
    context: {
        surfaceId: string;
        revision: number;
        epoch: string;
        entryIds: readonly string[];
    };
    routeSnapshotRef: string;
    instructionSetVersion: string;
    toolManifestVersion: string;
    projectionVersion: string;
    replayDecisionsRef: string;
    inputSegmentsRef: string;
    cachePlanRef: string;
    measurementRef: string;
    sanitizedWireRef?: string;
    captureCoverage: 'complete' | 'partial' | 'redacted' | 'unavailable';
}
```

另建受保护的 PreparedRequest 执行对象，包含已经冻结的最终 request body、必要传输配置以及清单。数据库记录不直接保存这个对象的认证部分。

同一 `requestId` 的纯网络重试保持相同语义输入与计划，仅 `attemptId` 改变。发生新用户补充、relay 纳入、路由切换、压缩或字段兼容降级后是新的逻辑 request，不能伪装成原请求无变化的重试。

---

## 6. 稳定系统规则与动态状态的拆分

### 6.1 现有代码的直接落点

`prompt-assembler.ts` 不再将所有 section join 成唯一 instructions。建议返回：

- `stableInstructions`：已确定版本的 host / Agent 工作方式、输入可信度规则、工具使用规则。
- `policyState`：确实影响指令权威或权限模式的控制面变化。
- `runtimeSnapshotCandidates`：Git、工作目录、已核实环境、必要任务状态等数据。
- `assemblyManifest`：来源、模板/内容版本、包含理由和 hash。

对 `renderPromptContext(profile.instructions, context)` 也做审计：如果 Agent 自定义模板将动态 slot 插入稳定规则内部，应明确标记该模板会破坏前缀；提供兼容旧模式与迁移提示，不应暗中改写用户指令。V2 新模板应把可变 slot 改成对尾部有类型快照的引用规则。

### 6.2 字段迁移表

| 当前字段/内容 | V2 去向 | 触发条件 |
|---|---|---|
| host.contract、工具操作方法、恢复规则说明 | 版本化 stable instructions | 实际规则改变 |
| AgentProfile 的专业要求 | 版本化 stable instructions | 用户明确切换/覆盖 |
| runId、requestId、attemptId、当前时间 | 默认只在日志元数据 | 模型确需可操作 ID 时单次明确提供 |
| taskTreeBudget.elapsedMs、每次消耗计数 | 日志/用量面板 | 模型只接收有用的预算预警或显式查询结果 |
| 当前预算进入 low/critical 状态 | tail 的 budget 状态快照 | 分级变化，而非每轮毫秒变化 |
| Git 分支、工作树状态、工作目录 | tail 的 runtime snapshot | 语义状态真实变化 |
| toolProgress 计数 | 默认日志；关键失败事实已在工具结果 | 接近纠错阈值或需要模型改变行动时追加简要提示 |
| permissionMode / Plan 切换 | host policy transition + 必要的 tail 通知 | 控制面实际变更，host 执行门立即生效 |
| 当前工具完整 Schema | 独立工具 manifest | 能力或声明变化 |
| tools 列表的重复自然语言展开 | 尽量删重复或固定使用规则 | 不再每轮拼出大段工具目录 |
| 子代理结果、阶段报告、用户 steering | 各自独立来源的历史条目 | 持久受理后在安全边界选入 |

不能为了缓存使模型继续看到错误工作目录、过期文件事实或旧权限。必要状态即时记录、在下一安全请求使用；host 权限门不等待下一次模型请求才生效。

### 6.3 快照去重

采用分 section 的语义比较。仅规范化 host 自己拥有的结构化数据：固定字段顺序，集合有明确排序，去掉非语义计时/展示字段。不能规范化用户原文、文件内容、模型原生块或签名载荷。

推荐首期使用“简短完整 section 快照”，而不是复杂的 JSON patch 链，便于摘要后恢复与人工理解。一个 snapshot 可以包含多个同一时刻改变的 section，按固定顺序合批。

只比较最新 retained snapshot；A→B→A 必须再次追加 A。清空记忆/取消工作目录等状态要追加 tombstone，不是简单不发；否则历史中的 B 会继续被误认为有效。

新增快照应先持久提交，随后才进入实际 request。重试复用这个 entry，不再重新读时钟生成快照。

### 6.4 系统策略变化

普通运行事实适合 tail 数据，不意味着所有指令都可以降为 user 角色。

- 支持同等高优先级历史更新的路由：追加版本化策略变更，由专用编码器表达。
- 不支持或未经验证的路由：重建有效系统头、记录 contextEpoch 的变化和原因；允许一次必要的缓存损失。
- 切换模型/工具策略/压缩后若需要整理历史 system：按规则合并或失活旧节点，不能同时留下互相矛盾的有效指令。
- 旧 Plan 禁令不通过“后面 user 说已经解除”来覆盖一个仍有效的 system 禁令。应使用模式无关的静态规则 + 受控状态，或合法重编译系统策略。

---

## 7. 稳定历史、工具声明和协议编译

### 7.1 不从 UI 反推模型历史

将 `model-history.ts` 的职责拆为 legacy import、canonical surface 查询和 native replay gate。V2 正常请求读取 active surface，不再每个新 run 重新把完整历史转成公开消息再尝试还原。

`conversationMessages()`、`displayedReply()` 可以继续用于展示、搜索和旧数据导入，不能作为 V2 assistant/tool 原始语义的主存储。用户编辑内容产生新分支/修订事件，使对应 replay 失效；不修改旧 frame。

### 7.2 不以固定轮数滚动丢头

V2 默认由实际预算和明确压缩事务管理活动窗口。保留用户显式配置的历史裁剪选项时，将它作为有日志的上下文策略边界，不悄悄改变设置，也不把该模式的缓存损失混进普通 append-only 验收。

旧 run 上的压缩 active pointer 需要投影到 branch 级有效窗口，避免新 run 又从旧完整历史恢复，重复触发同一段压缩。

### 7.3 工具 manifest

声明集合有稳定顺序、结构版本和内容 hash。对 host 生成的新 JSON Schema 采用固定序列化；不得每轮依赖对象创建/插件加载/并行结果顺序。

保留同一版本的已发送声明文本和顺序。不能一会儿给 tools 全描述，一会儿缩写，再指望历史缓存连续。

当前 `appendToolResults()` 已按调用顺序排列结果并校验配对；保持该行为，不改成并行完成顺序。[S08]

历史上声明过某工具不意味着现在可以执行。必要的真实工具禁用/权限调整可以改变 manifest 并产生有解释的边界。禁止为了冻结 tools 而宣称未接入能力可用。

若未来支持工具增量更新，按 route capability 投影；不支持时重发当前声明并记录重新预热。MCP deferred loading 不属于现有协议的默认能力。

### 7.4 确定性编译

compiler 接收纯数据快照；不读文件、时钟、Git 或 mutable registry。它输出协议 body 草稿、可见 segment/source map、回放决策、合法断点候选位置和计量输入。

必须保留用户/模型文字的空白、换行、Unicode 与代码原文。不要每次 trim、重新 Markdown 排版或对已有工具 arguments JSON 重排键。只有协议确需对象化时才由固定版本转换，并保持后续请求一致。

新的内容块也必须保留有序性：正文→工具调用→对应结果，不能先把所有正文合并到开头，再把工具调用排到末尾。

### 7.5 逐阶段防漂移

Request observer 的 `prepared` 已接近实际最终 body，是诊断接入点。[S07]

V2 需保证“记录的模型输入清单”与“实际发送 body 的模型可见部分”对应。若 SDK 或适配器在其后改写内容，应把该改写移入可测编译阶段，或把观察点下移到最终 fetch 边界。

不能把脱敏后的 body 当作原生回放原件。日志允许脱敏，但相应重建覆盖度要真实标记；受保护的 replay 储存另按现有政策管理。

---

## 8. CachePlanner：不能只缓存系统提示

### 8.1 两种问题必须分别诊断

**输入前缀破坏**：共享历史之前的实际内容改变。修复点是 Context Engine。

**缓存策略不覆盖历史**：输入未改变，但请求没有启用对应缓存、没有可复用写入点、断点查找越界、缓存过期或上游未命中。修复点是 CachePlanner / provider profile / 运行条件。

OpenAI 当前文档明确区分新旧模型族的缓存匹配；新一代断点模式不保证回退到未标记的最长相同前缀。因此不能继续把“OpenAI 兼容”解释成“只要字符串稳定就自动做好缓存”。Anthropic 则有其自身的断点及回看规则。[S17, S18]

### 8.2 RouteCacheProfile

建议能力概念，而非通用 wire 字段：

```ts
type CacheMechanism =
    | 'implicit_prefix'
    | 'explicit_frontier'
    | 'breakpoint_lookback'
    | 'external_runtime'
    | 'unknown';

interface RouteCacheProfile {
    id: string;
    version: number;
    mechanism: CacheMechanism;
    supportsCacheKey: boolean;
    supportsExplicitMode: boolean;
    maxBreakpoints?: number;
    lookbackPositions?: number;
    minimumTokens?: number;
    supportedTtls?: readonly string[];
    evidence: 'official' | 'configured' | 'fixture_verified';
}
```

另由 adapter 定义哪些 wire content/消息/工具组是合法断点、系统头使用哪种表达、怎样计算查找位置、哪些参数会影响隐含提示。未知能力不得按最激进方案发送。

`evidence` 不是宣称已经跑通真实 provider；fixture_verified 只表示本地序列化一致。真实服务验证证据单独记录。

### 8.3 三类缓存边界

- **稳定基线锚点**：确实将在后续请求重复的初始规则/声明/必要初始上下文结尾，且该路由允许标记。
- **历史 frontier**：先前实际请求曾安排写入、现在仍完整保留的历史前缀结尾。
- **本次推进点**：本次请求最新的合法完整输入边界，预计会在下一步继续使用。

不能永远只标 stable system。那只能节省一个固定头部，输入增长后命中占比仍可能下降。

也不能只把唯一断点移动到最新消息，却不考虑之前写入点是否还能被找到。

### 8.4 持久化 CacheFrontier

为每条 branch / route-compatible cache lane 保存候选：

- 边界所对应的 entryId + blockId / 完整工具结果组。
- 边界前模型可见 segment hash chain root。
- 投影版本、请求形状 fingerprint、认证域和模型身份。
- 哪次真实请求安排过该点、何时开始请求、有无 response-start / usage 等证据。
- 是否仍位于 active surface，TTL 估计与不确定状态。

**不能把 HTTP 2xx 或 aggregate cache_write 直接说成“这个具体断点已经确认写入”。**服务未逐点返回证据时，只能保存候选及其证据强度。未来请求的 cached usage 才证明真实发生了缓存读，仍未必能精确定位是哪一个边界。

frontier 记录跨 run 和重启恢复；它不是仅存于 agentLoop 局部变量的 `lastCacheIndex`。分支编辑或摘要覆盖了某个边界后，该边界失效；前面的稳定锚点仍可能可用。

### 8.5 推进算法

以下是策略伪代码，不是直接可运行的 SDK 调用：

```text
输入：已编译模型输入、合法断点、当前路由 profile、历史 frontier 候选

1. 过滤不兼容/不在当前前缀/内容 hash 已变化的旧 frontier。
2. 找到仍有效且最有价值的旧历史 frontier。
3. 选择必要稳定锚点；短于有效门槛时不为指标而填充废话。
4. 选择本次最新合法完整输入边界作为推进点。
5. 按机制分配有限槽位：
   - implicit_prefix：通常不加不支持的字段；保存诊断候选。
   - explicit_frontier：旧 frontier 和新推进点可同时存在；必要时留稳定锚点。
   - breakpoint_lookback：确保旧写入点在可查找范围内，必要时显式保留旧 frontier。
6. 去重重合点，检查合法角色、TTL 一致性、槽位总数。
7. 输出 CachePlan；不修改 CanonicalEntry 内容。
8. 最终 body 与 CachePlan 一起形成冻结请求和持久清单。
9. 实际请求到达服务后，更新候选证据；失败/取消保留未知，不伪造写入。
```

优先级建议：保护已有高价值历史 frontier → 安排新的可复用推进点 → 必要稳定基线 → 可选中间锚点。具体顺序按 route profile 的读写语义调整，不把这个优先级当作所有 API 的固定语法。

### 8.6 一个需要覆盖的关键例子

```text
R1：S + H1 … H10             在 H10 安排写入
R2：S + H1 … H10 + H11 … H30
```

R2 的前缀没变，但只把唯一标记移到 H30 未必能找到 H10。V2 需要在适合的路由上保留 H10，再在 H30 安排下次可用的推进点。R3 可以使用 H30，并移除无必要的旧点，受断点上限约束。

H10 / H30 表示“协议认可的位置”，不是第十/第三十条 UI 聊天气泡。工具调用与结果的合并、content block 划分会影响位置。compiler 必须产出 source map，不能让 CachePlanner 自己再次猜协议结构。

### 8.7 三条现有桌面路径

| 路径 | V2 行为 | 不能做的事 |
|---|---|---|
| OpenAI Chat / Responses 的隐式前缀型路径 | 保持内容稳定；按能力使用稳定 cache key / retention；记录实际 usage | 不给所有兼容网关强塞 OpenAI 扩展字段 |
| OpenAI 的显式断点型路径 | 根据该模型与 API 的合法字段生成断点；可配置 explicit-only；保留旧 frontier 并推进新点 | 不仅移到最新点；不只缓存系统头；不每次生成随机 key |
| Anthropic Messages 的 breakpoint 路径 | 支持 block-level / 经验证的 top-level cache_control；安排稳定锚点和历史推进；验证槽位、回看和 TTL | 不给每块都加标记；不能直接标记不支持的块；不能把所有兼容服务都视为官方原生 |
| DeepSeek 的 Chat 兼容路径 | 按该 route 的隐式缓存能力处理；读取标准和专有 usage 形态 | 不因为 API 看起来像 OpenAI 就只承认一种 usage 格式 |
| 官方 CLI 托管 runtime | 仅展示外部证据/未知；缓存与上下文由外部 runtime 管理 | 不在 UAH 再次改写其内部请求或摘要 |

OpenAI / Anthropic 的实际字段、门槛和计费语义应在实施时根据 [S17, S18] 为选定模型生成固定 fixtures。不要在业务主循环散布 `model.includes(...)` 判断。本文不提供可直接复制到所有端点的通用缓存 JSON。

### 8.8 cache key 与 TTL

cache key 是受能力约束的复用/路由提示，不是内容记忆，也不是命中保证。建议使用无敏感信息的稳定 lane 标识；普通 run、attempt、token 消耗变化不能改变它。是否跨分支/会话共用必须受用户数据隔离与 provider 规则约束，默认先把同一会话做好。

TTL 是缓存控制与潜在成本选项，不是越长越好。按实际模型支持、生成耗时、工具/审批间隔统计选取；不得偷偷修改所有用户到最贵的长 TTL。过期、冷启动、路由切换应单独标记，而不是被解释为编译器 bug。

不新增后台付费 prewarm，不用 keepalive 请求维持缓存。下一条真实用户/任务请求自然推进 frontier。

---

## 9. 原生回放与跨模型降级

### 9.1 在现有 ModelFrame 基础上升级

保留目前 completed 状态、公开修订指纹、协议、模型和账号隔离的约束。[S09]

新增清晰的 ReplayEnvelope / replayRef：源 route / model / API、响应模型别名、schema/adapter version、content binding hash、按块对齐的签名/原生信息、捕获 coverage。

原始请求模型身份用于兼容判断，provider 响应中的别名可用于诊断，不能自动替换并污染后续回放身份。

### 9.2 降级阶梯

```text
兼容且完整：原生保真历史
         ↓ 不兼容/版本不支持
通用语义历史：用户原文 + assistant 正文 + 工具调用/结果 + 附件引用
         ↓ 信息确实缺失
有限公开证据历史：明确 coverage 与丢失范围
         ↓ 预算压力
通过已提交的摘要/卸载策略缩减
```

不能像简单“原生 or UI”二选一那样，在切模型时立即丢掉大部分工具过程。兼容失败只是保真失败，不一定是事实丢失。

### 9.3 兼容矩阵

- 同路由同模型且内容未编辑：保留必需 thinking/signatures/Responses items。
- 协议相同、模型不同：不默认复用私有状态；使用显式能力规则。
- 模型同名、端点或账号域不同：默认拒绝私有回放，保留可移植内容。
- UI 编辑 assistant：新修订没有旧签名授权；旧 frame 不可继续绑定新正文。
- opaque 块不可读或被脱敏：标记 replay coverage，不能把修改后的数据冒充原件。
- 同一 provider 升级 serializer：若行为变化，生成有解释的投影版本边界，不随机混用新旧格式。

### 9.4 工具 ID 映射

原始 tool call ID 在 canonical history 不变。目标协议需要改写时，生成稳定且有冲突检测的 source-origin + callId → wireId 映射；调用和结果共用同一张映射。

禁止每次重放用 UUID 替换工具 ID。不同分支/导入的相同原始 callId 不能发生别名碰撞。

完整工具结果按照原调用顺序投影；不会因并行任务先后完成改变历史顺序。

### 9.5 中断恢复

未闭合批次保持 blocked / needs_reconciliation，不能让 serializer 猜测执行是否发生。对确认未执行的工具可以持久化明确的 not_executed 结果；对未知副作用保留 unknown 并遵守现有人工核对流程。

若需要协议修复说明，先产生可审计的 repair projection，再编译请求。repair 不是工具执行，也不能出现在“执行成功”统计中。

---

## 10. TokenMeter 与传输预算

### 10.1 分开四种量

| 量 | 用途 |
|---|---|
| 模型输入估计 | admission、压缩阈值、UI 分项 |
| provider reported usage | 实际用量、缓存读写与成本统计 |
| serialized body bytes | 网络/内存/SDK 请求上限 |
| task tree 累计预算 | 控制整个主/子任务树的成本和运行资源 |

它们可以不同，但必须绑定同一个 RequestManifest / context revision。不得把 UI 的可见文本估计误称为 provider 精确 token 数。

### 10.2 Meter 输入

使用最终协议投影对应的内容、工具声明、图片请求版本以及已知 framing 规则计量。模型 tokenizer 可用时按确切模型/版本使用；不可用时使用显式的保守估计与误差范围。中文、代码、JSON、base64、图片、加密 replay 分别处理，不对整个 JSON body 永久用一个比率。

真实 usage 可用于同一路由/形状的校准，但必须保存 source 与时间；切换模型、改变图像策略或投影方式后，旧锚点不能无条件沿用。加密 reasoning 无法估计时保留 uncertainty / 预算安全余量，而不是当作零。

### 10.3 阈值建议

设 W 为确切路由窗口、O 为有效输出预留、R 为误差与下一批受限工具结果的余量。压缩触发输入阈值可取：

`T = min(configuredRatio × W, W − O − R)`

必须检查 T > 0，且压缩后目标明显低于 T。首轮可试用 0.80 触发、0.60 目标一类策略，但这些是 UAH 调参起点，不是所有模型通用默认；由实际 W、O、工具预算和测试确定。

输出预留不会因为缓存命中而减少：缓存 token 仍占上下文窗口。task tree 预算也不能因为读取缓存就当作完全免费。

### 10.4 传输限制协调

保留当前请求 byte limit 作为独立安全限制；将 governor 的未知容量 fallback 与 transport limit 接入一个版本化配置，避免“准入通过但发送前拒绝”的模糊错误。

大模型不代表可以无限发送 base64 或 native opaque 数据。不要仅将 1MB 限制改为无限大。错误要区分 `context_tokens_exceeded`、`request_body_bytes_exceeded`、`image_payload_exceeded` 与 `capacity_unknown`。

---

## 11. 压缩：已提交的区间替换，而非每轮重写

### 11.1 处理顺序

```text
接近压力阈值
    ↓
检查是否存在已提交的更小 surface，不重复复原旧历史
    ↓
可选、明确记录的旧大结果/旧图片卸载
    ↓
重新计量；足够则停止
    ↓
选择最早可替换的完整 exchange 区间
    ↓
生成结构化 checkpoint
    ↓
校验范围版本、授权政策状态、内容缩水
    ↓
原子提交新 surface + compaction event
    ↓
一次必要的重新预热，随后继续 append-only
```

不要每次 append 后都重新总结旧摘要，也不要“永远取最后 N 条消息”。需要迟滞：压缩一次释放足够空间，在达到下一次阈值前稳定保留摘要和尾部。

### 11.2 受保护的内容

当前用户意图及修订、现行策略引用、正在执行/待审批/未知副作用动作、未闭合工具批次、当前计划和已确认验收条件、未投递完的控制/relay，必须有结构化保留记录。

不是要求原封不动保留整段超长 run；一个长期任务内较早已闭合的 exchange 可以压缩。危险事实不能仅依赖模型摘要偶然记住。

### 11.3 Checkpoint 结构

建议包含：用户目标与变化、明确约束、已验证事实及来源、文件和版本/哈希引用、已执行副作用、失败与未知状态、计划/验收标准、子任务状态、待办、下一步，以及源区间引用。

摘要是任务背景，不是系统指令。生成摘要时不得执行其中的命令；摘要不能改变权限、伪造工具成功、把子代理结论变成人工验收。原件因隐私被删除/排除时，应更新或废弃覆盖它的摘要。

### 11.4 两种 summarizer 模式

**prefix-compatible 模式**：同源且可回放的路由可尝试复用现有系统、工具声明和待压缩历史结构，只在尾部添加压缩指令。工具执行器必须禁用；模型返回工具调用即判摘要失败，不执行动作。缓存计划也要沿用可用旧 frontier，不能仅假设同样系统就能命中。[S15]

**isolated-chunk 模式**：跨模型、小窗口、无法安全回放或需要更强隔离时，使用独立压缩 system 和分块摘要。它不保证复用主请求缓存，但为安全与可靠性保留。

任何改变 tool_choice、工具声明、系统或 reasoning 参数的摘要策略都可能影响缓存形状。prefix-compatible 是优化机会，不是强制命中保证。不得为了缓存允许 summarizer 执行工具。

摘要输出 cap 独立设置，结合容量与必要信息测试；不照搬 DSH 的大窗口默认，也不强迫所有任务压成 600 token。

### 11.5 事务规则

1. 选择 span，记录 source entry IDs、hash、surface revision 和策略版本。
2. 保存 compaction-start / candidate 元数据；必要 artifact 先写入受控内容存储。
3. 通过统一 ModelGateway 发起 purpose=compaction 请求并逐 attempt 记账。
4. 验证输出完整、有实质缩减、无非法工具输出；重新验证选中 span 与策略。
5. 同一数据库事务写 compaction replacement、active surface pointer、必要 projection/outbox。
6. 失败或取消：旧 surface 保持有效；未引用的候选 artifact 后续由现有 GC 清理。
7. CAS 冲突：不覆盖新历史。首期可以拒绝过时候选；允许未来优化为“选中区间未变，尾部追加合并”，必须有测试。
8. 重启发现未闭合事务时，恢复为未提交/需处理状态；不自动重复付费摘要，不自动重放工具。

### 11.6 Overflow 与重试

provider 明确 context overflow 时，先确定错误分类，不把所有 400 当作超窗。一次有效压缩后允许有限重试；如果 surface 没有变小，就不要再次提交完全相同的超限输入。

超长单个不可拆分单元无法安全装入窗口时，明确暂停或使用已有可读 artifact 引用策略；不能从中间截断原生工具调用/签名让请求“看起来能发”。

---

## 12. 工具结果与附件：先降低增量，再减少旧历史改写

### 12.1 工具结果预算在首次入上下文时决定

完整工具输出进入受控 artifact；首次提供给模型的是稳定、可理解的有限视图和读取引用。视图可以包含错误段、首尾、关键行与 truncation 标记；不能只留下“成功”两个字。

将每个工具的预算策略固定在版本化 registry：目录列表、搜索、diff、命令输出采用不同上限。读取原件的分页结果进入后续正常工具历史，不反过来重写第一次输出。

已显示给模型的老结果不能随着对话变长而每轮逐渐缩短。后续卸载是明确的 surface replacement，记录一次失效点。

### 12.2 图片/文件引用

桌面当前文本路径的改造不能假装同时完成所有多模态 provider。先为 attachment occurrence、content hash、request variant、offload 决策留下契约，后续支持时使用同一机制。

每张截图出现位置独立，不能仅按 attachmentId 全局删除所有出现。请求版本要确定性；重放时不因为重新编码质量、临时路径或随机文件名改变旧图片表达。

卸载保留可读引用及已记录的观察，但不能说模型读过未发送的文件字节。敏感文件引用和本地路径遵守现有权限与日志政策。

### 12.3 性能边界

active surface 用条目引用/持久序列，不在每个 run 复制出一份完整历史。hash 与计量可按条目缓存并增量维护；完整网络序列化必然与本次输入规模有关，不追求虚假的 O(1) 请求生成。

日志优先保存不可变内容、请求 manifest 和引用差异；完整 raw request 按已有 capture policy 保存。不能让每次请求存两三份全量历史，造成累计 O(n²) 的非必要复制和磁盘放大。

---

## 13. 请求边界、用户补充和子代理中途消息

与 `UAH_Subagent_Intermediate_Messaging_Plan_2026-10-03.md` 共用语义，不另建第二个消息系统。[S21]

### 13.1 边界规则

受理的输入先持久化。模型正在生成时消息只排队；完整工具批次结算后，在下一安全请求前合批选入。

固定请求所用 surface revision、队列 watermark 与权限版本。随后到来的消息属于下一请求，不能在已发送 body 中途加入，也不能仅为收到一条 relay 就另开并行父循环。

“读取 Git 期间来了 steering”可在尚未发请求时放弃草稿并重新构建。放弃草稿不算真实模型请求，但其准备记录和预算处理按现有规范标记；已发送后的变更不能偷偷套用旧 requestId。

### 13.2 一次纳入，多次重试

relay / steering 的 entryId 与 deliveryId 不变。第一次请求计划包含后，重试复用同一条历史，不重复 append，也不把成功发出等同于父模型已理解。

投递阶段至少区分：accepted、included-in-request、dispatched、response-observed；沿用旧方案已有命名时保持兼容。不要把协议缺少的“已阅读”回执虚构出来。

### 13.3 父子上下文隔离

子代理继承 `none/selected/all` 时取得明确来源的上下文投影，不共享父 agent 的可变消息数组。子代理自己的运行状态、思考、工具输出不会自动污染父历史；只有显式交接进入父 surface。

父子用不同模型/端点时，各自应用 replay gate 和缓存 profile。不能为了让 worker 命中父前缀，越过账号隔离或把全部父私有 reasoning 发给子模型。

---

## 14. 日志、指纹和缓存故障定位

### 14.1 两种 hash，不要混为一个

**wire payload hash**：用于解释真实请求体是否变化。JSON 容器闭合符、请求参数、缓存控制都可能影响它；安全存储使用脱敏表示或受控 keyed fingerprint，并标明覆盖范围。

**model-input segment fingerprint**：用于定位前缀内容变化。按 adapter 声明的模型可见顺序记录稳定规则、工具、消息块、原生 replay/图片等 segment。缓存控制拓扑、路由/隐含提示相关参数另有 requestShapeFingerprint。

不能直接对整段 HTTP JSON 做字符串 LCP，然后把它叫“模型 token 缓存命中率”。例如 JSON 顶层键顺序并不代表 provider 内部提示排列；数组追加也会改变原先的结束标点。

模型服务端的私有格式化/分词不可见时，应称为“本地前缀保留估计”，不宣称精确等同 KV 前缀。

### 14.2 每次请求增加的诊断字段

记录：上一可比较 requestId、lineage/epoch、系统与工具 hash、按序 entry refs、总输入估计、共同前缀估计、最早变更 segment 与 source entry、replay downgrade 数量与原因、cache plan、实际 cached/read/write usage、coverage、请求用途、byte size、首 token 时延、重试和压缩关联。

尽量引用现有 RequestJournal / transcript artifact，不再写一份平行大日志。

### 14.3 变更原因枚举

建议稳定代码：

`cold_start`、`append_only`、`runtime_snapshot_changed`、`policy_changed`、`tools_changed`、`model_changed`、`endpoint_changed`、`auth_scope_changed`、`history_edited`、`history_excluded`、`branch_changed`、`compaction_committed`、`attachment_offloaded`、`replay_degraded`、`serializer_changed`、`cache_plan_changed`、`ttl_likely_expired`、`upstream_unknown`。

多个原因可以同时出现，但必须区分：

- 已经从请求输入确定的原因。
- 根据时间/配置推测的原因。
- 无法从客户端证实的上游原因。

### 14.4 UI 展示

沿用现有上下文面板增加三个区域：

1. 本次模型实际输入：来源、类型、位置、是否摘要/卸载/回放降级。
2. 前缀诊断：与上次请求相比，最早变化在哪里，是否为有意策略变更。
3. 缓存证据：真实 read/write、统计覆盖度、缓存机制与断点；缺失写“未知”，不要画成 0%。

点击某次 request 能跳转关联 transcript / tool outcome / compaction，而不只展示拼接前的 prompt modules。

UI 示例（数字均为示意，不是实测）：

```text
本次：42k estimated input，provider reported input 43k
本地旧输入前缀保留：100%（估计，未含服务端私有模板）
服务端 cache read：36k / 43k
历史推进点：entry-188 → entry-201
变化：新增 Git 快照、2 条工具结果；旧 system 与 tools 未变化
覆盖度：complete；用途：agent；无压缩与网络重试
```

---

## 15. UsageNormalizer：先修正度量，再谈百分比

### 15.1 共用字段的语义

建议统一 `inputTokensTotal`、`inputCacheReadTokens`、`inputCacheWriteTokens`、`inputUncachedTokens`、`outputTokens`、`reasoningTokens`、`reportedTotalTokens`、`coverage`、`sourcePaths`。

不是每个 provider 都报告全部字段。`reasoningTokens` 常是输出子集，不能额外加一次。cache write 不一定与输入总数互斥或额外增加上下文 token；成本分类与上下文长度分类分开。

### 15.2 当前优先覆盖

- Anthropic：保留当前已实现的 input / cache-read / cache-creation 不重叠合计方式，不回归成只读取 input_tokens。[S08]
- OpenAI：保留标准 input/prompt tokens 和 details.cached_tokens；按实际 schema 支持新 cache-write 明细，别再假设所有缓存写入都免费。[S17]
- DeepSeek Chat：支持标准 details.cached_tokens 和专有 prompt_cache_hit_tokens / prompt_cache_miss_tokens。当前官方文档同时列出标准与专有表示；若两者都有不能相加，两者冲突要报诊断而不是挑较大值。[S19]
- pi-ai backend：先核实它的 usage.input 是否表示未缓存部分，再转换到 UAH total；不能套用 OpenAI 原始字段定义。

### 15.3 汇总公式

对有完整、可信 input 与 cache-read 计数的请求集合 K：

`weightedCacheReadRatio = Σ(readTokens_i) / Σ(inputTotal_i)`

同时展示 `known-request coverage = |K| / 实际模型请求总数`。若部分请求只缺缓存计数但有输入总量，应另报已知输入量覆盖程度；缺 input 的请求不得猜测补齐。

不能计算“每次百分比的算术平均”来代替 token 加权比例。不能把缓存读比率除以 input+output。不能将 cache write 当作 cache hit。

所有真实尝试包括失败、取消、摘要、标题、子代理都进入 ledger；界面可按 purpose、route、warm/cold、epoch、compaction segment 筛选，但必须保留全量产品指标。

### 15.4 流式结算

同一 attempt 的 usage delta 若为累计计数则更新，不求和。只在结算时形成一条汇总；部分 streaming usage 保留 partial，后来的完整字段修正同一 attempt 的版本，而非新增一笔消费。

预算保守预留与真实账单统计分开。未知用量可以保留预留用于安全，但 UI 不应声称该预留是 provider 已计费 token。

---

## 16. 测量方法与验收指标

### 16.1 双轨验收

**轨道 A：确定性离线机制验收，必须通过。** 使用固定虚拟 provider/transport、中文与代码混合记录、可控时钟、进程重建和故障注入。测量实际编译 body 与 manifest，不只是 assembler 输出。

**轨道 B：真实 provider 小规模 A/B，显式授权后执行。** 分离冷启动、warm 连续、重启恢复、长时间等待、跨 route、压缩后预热。真实缓存结果只能来自原始 provider usage；模拟器生成的 cache hit 不属于线上证据。

### 16.2 主验收标准

| 类别 | 门槛 |
|---|---|
| 普通追加正确性 | 未发生声明的策略/路由/编辑/压缩边界时，已有模型输入条目顺序和内容保留 100%；必要协议归一化必须有固定 golden |
| 隐性头部变化 | 仅时间、预算计数、runId、UI 状态改变，不得改变 stable instructions/tools 或既有 history |
| restart | 同配置重启不产生无意义 system / snapshot；本地谱系与 frontier 可恢复；不保证过期服务端缓存仍热 |
| 工具配对 | 0 孤立结果、0 重复结果、0 悬空批次被悄悄修复为成功 |
| 输入可追溯 | 所有 dispatch 都有 request manifest；无法保存记录按既有 fail-closed 规则处理 |
| 用量 | 无双算；未知率和用途明示；专有/标准字段冲突有测试 |
| 压缩 | 无效或冲突候选不得替换旧 surface；成功替换在新 run/重启后保持 |
| 真实 warm 目标 | 在同 route、缓存门槛已满足、TTL 有效、无重编译、每步新增输入较小的受控长对话中，以 token 加权读占比 ≥80% 为优化目标；不是通用 provider 保证 |
| 产品收益 | 报告全任务成本、cache-write 成本、首 token 延迟与成功率；不得通过无用填充、漏记辅助请求或降低完成质量达标 |

如果离线前缀稳定、断点计划正确，但真实 warm 仍低，继续检查 TTL、匹配粒度、服务端读写与网关改写。不能通过放宽前缀测试或篡改分母把它标为完成。

### 16.3 固定 benchmark 场景

B01：同一 run 的 30 次完整工具循环，只推进时钟/预算，项目内容不变。  
B02：同一会话 20 个用户 run，每次有少量新文本和固定工具结果。  
B03：中文、英文、代码、JSON 混合；中长上下文档位及接近窗口阈值。  
B04：Git 状态不变 / 真实变更 / 清空工作目录分别测试。  
B05：一次新增大量合法 content 位置，验证历史 frontier 未被回看窗口漏掉。  
B06：并行工具完成顺序随机，但模型输入结果序保持原调用顺序。  
B07：每第 5 次请求退出并重建运行时，恢复同一 branch。  
B08：触发一次压缩，随后运行足够多追加请求，确认只在替换边界失效，不每轮重新摘要。  
B09：父代理收到子报告，子仍在 barrier 上；下一实际父请求已包含报告。  
B10：多种 provider usage 原始形态、无终态、取消、SDK 重试和未知计数。

基准负载、文本和工具输出使用可重放固定 fixture，而非两次任由模型生成完全不同任务轨迹。lane 的初始唯一标识如用于隔离测量，只生成一次，不能每轮改变模型输入。比较 A/B 时披露彼此可能共享服务端缓存的污染风险。

### 16.4 性能与存储验证

记录上下文准备时长、峰值内存、序列化字节、每次新写内容字节和 manifest 大小。在同一测试机和相同输入上比较旧实现。要求线性输入工作之外不存在逐 run 全历史再复制/重复落盘的额外放大。

不要未经基准就填写固定毫秒 SLA。给出 P50/P95 与上下文大小的增长曲线和原始结果文件。

---

## 17. Android 的对应范围

Android 不需要照搬 TS 类名或数据库实现，只共用事件语义、版本定义与 JSON 测试向量。

上轮核查的 Android 已有 `systemPromptSnapshot` 与 `appendEnvironmentIfChanged()`，不要为了“统一 V2”退回每轮重建 system。保留 ContextCompactor 的失败保护和分块模式。[S04, S22]

优先顺序：

A01：为 `ProviderBlocks` 增加源 model、provider/endpoint/credential scope、格式版本和内容绑定；不能只靠 anthropic/gemini 协议 key 回放。  
A02：运行快照语义去重、A→B→A 和 clear tombstone、压缩后恢复快照。  
A03：接入等价 RequestManifest、UsageNormalizer 与 cache profile。  
A04：压缩/工具配对/停止和重建采用共用 fixture；维持 Kotlin 协程的取消语义。  
A05：复用桌面已稳定的 CacheFrontier 行为，按 Android 实际 provider 路径单独编码；不假设桌面三协议涵盖 Android 全部能力。

Android 的文件存储与进程回收约束用其本地权威存储实现，不为了共用测试强行改成桌面 SQLite 模块。

---

## 18. 桌面实施工作包与依赖

### C00 / P0：最终请求观测和可重复基线

**现有落点**：`src/runtime/api-transport.ts` 的 prepared observer、`request-journal.ts`、`request-context.ts`、`diagnostics.ts`、现有 usage 事件；新增离线 benchmark fixture。

**实施**：在不改变默认请求的前提下，记录最终协议输入的分段 hash、稳定/动态模块来源、cache 字段存在性、body bytes、各 attempt usage coverage。完成 F01–F09 的证据表；对仅时间变化的输入找出第一个差异。缓存指标不可见时展示 unknown。

**交付**：baseline JSON、变更点报告、至少覆盖三协议的最终 body fixture。测试代码不得发真实外网请求。

**退出条件**：能从 requestId 定位系统头 churn、历史变化或缓存策略缺失，而非只输出一个全文 hash。此阶段不宣称缓存改善。

### C01 / P0：CanonicalEntry、active surface 和准备快照

**依赖**：C00。

**现有落点**：`src/shared/harness-contracts.ts`、`src/runtime/store.ts`、`model-history.ts`、`run-journal.ts`、`request-journal.ts`。

**建议新增**：`src/runtime/context/contracts.ts`、`surface.ts`、`prepare.ts`。可与现有 contracts 合并，不要求机械拆文件。

**实施**：增加 branch 级 active surface、不可变 entry 引用、版本和 source refs；RouteSnapshot 与 PreparedRequest；沿用 SQLite 原子提交/outbox。支持重放和 coverage。禁止数组别名跨父子和请求传播。

**交付**：向后兼容 schema migration、存储事务测试、冻结/热更新隔离测试。

**退出条件**：同一快照重复 prepare 输出相同模型输入；请求在飞行时配置变更不能改变它；普通重启不自动新建 epoch。

### C02 / P0：稳定系统提示与变化快照

**依赖**：C01。

**现有落点**：`prompt-assembler.ts`、`prompt-context.ts`、`supervisor.ts` 的 assemblePrompt / budget snapshot / Git 路径。

**建议新增**：`src/runtime/context/runtime-projection.ts`。

**实施**：按第 6 节字段迁移表拆分；删除非必要动态字段的模型注入而非删除日志；语义快照、tombstone、保留快照恢复；处理用户自定义 prompt slot；Plan/permission 真实切换的合法高优先级表达。

**交付**：同 run 多次循环与跨 run 固定前缀测试、Git 未变化和已变化测试、自定义模板兼容说明。

**退出条件**：仅 runId、elapsedMs、预算数字或 UI 状态变化，最终请求中的旧系统/工具/历史 segment 不变。模式变化不降低执行安全。

### C03 / P0：历史连续性、工具 manifest 与原生回放

**依赖**：C01；与 C02 可在独立文件上并行，但 supervisor/store 由单一写入者整合。

**现有落点**：`model-history.ts`、`api-transport.ts`、`tool-protocol.ts`、`supervisor.ts` 起始 continuation 与 `appendToolResults()`。

**建议新增**：`context/replay.ts`、`context/compiler.ts`；工具 manifest 可继续由现有 registry 持有。

**实施**：正常请求直接使用 active surface；一份通用语义历史 + 原生 replay envelope；稳定 tool ID 映射；工具声明排序/版本；把 endpoint display revision 与 replay/security domain 分离；显式历史编辑/删除/分支策略。

**交付**：三协议 native→canonical→wire golden、cross-model downgrade、编辑/原件缺失/身份切换测试。

**退出条件**：同会话多 run 不因重新导出 UI 而改变历史；必要降级只损失应丢弃的原生保真信息；工具语义和账号边界不放宽。

### C04 / P0：CachePlanner、frontier 与 provider-aware usage

**依赖**：C01、C03；C02 合并后验证真实前缀收益。

**现有落点**：`api-transport.ts`、`model-details.ts`、连接/模型 capability contracts、RequestJournal usage。

**建议新增**：`context/cache-planner.ts`、`context/cache-profiles.ts`、`usage-normalizer.ts`。

**实施**：缓存能力与协议分离；为实际支持的请求安放稳定锚点/旧 frontier/新推进点；前缀可见性和 cache topology 分开 hash；持久保存候选证据，验证 token 门槛/TTL/槽位/合法角色；支持标准与 provider 专有 usage，避免双算。

**交付**：三协议 body/cachePlan fixture、显式-only/隐式/未知profile测试、>lookback跨度、重启frontier、schema冲突测试。

**退出条件**：不能只固定缓存 system；新输入追加后旧 frontier 仍可被对应机制找到；未知网关不收到猜测字段；usage 缺失不作 0。

### C05 / P1：统一计量、压缩和有限超窗恢复

**依赖**：C01–C04。

**现有落点**：`context-governor.ts`、`context-compaction.ts`、`supervisor.ts`、`journal-artifacts.ts`、`artifact-tools.ts`。

**建议新增**：`context/meter.ts`、`context/compaction.ts`；也可渐进扩展原文件。

**实施**：分离 bytes/token/task budget；一次有收益的工具结果卸载；完整 exchange 区间选择；结构化任务 checkpoint；prefix-compatible 与 isolated 两种 summarizer；候选 CAS、缩水校验、原子 active pointer、purpose ledger、有限 overflow retry。

**交付**：阈值测试、长单 run 可压缩测试、失败/取消/冲突/重启测试、摘要工具调用拒绝测试。

**退出条件**：成功压缩后下一个 run/重启沿用新窗口；未缩水不提交；任一失败不损伤旧窗口；不在同一超限输入上无限重试。

### C06 / P1：可解释上下文 UI 与控制/relay 贯通

**依赖**：C01–C05；C00 的基础诊断不能等待此阶段才有。

**现有落点**：`request-context.ts`、`request-events.ts`、`transcript-writer.ts`、renderer 现有上下文/日志面板及对应 IPC。

**实施**：实际请求清单、最早变更点、真实缓存读写和统计覆盖度；steering/子报告作为 typed entries；沿用 Oct 3 消息计划，不重复创建邮箱。如果该消息功能尚未合入，提供明确 ingestion 接口和 barrier fixture，按原计划实现接入。

**交付**：source map 点击定位、unknown/partial UI、子代理未结束而父下一请求已经包含 report 的测试。

**退出条件**：面板与实际 body 一致；恢复、重试不重复投递；UI 不宣称模型“已读”；无控制消息提升权限。

### C07 / P1：迁移、特性开关、性能和删除一致性

**依赖**：C01–C06。

**现有落点**：`store.ts`、`store-backup.ts`、`session-purge-*`、`journal-gc.ts`、离线 transcript 工具。

**实施**：第 19 节的旧会话一次性迁移、shadow compare、branch 持久特性开关；compatible rollback；delete/exclude 所覆盖摘要失效；内容地址引用 GC；避免重复全历史复制。

**交付**：迁移失败恢复包、重复迁移幂等测试、删除回归、基准统计与版本兼容说明。

**退出条件**：旧会话可读，覆盖度诚实；迁移仅执行一次且不调用模型；关闭 V2 不会让旧代码错误解释 V2 日志或复活已排除内容。

### C08 / P1：总体验收与交付

**依赖**：C00–C07。

**实施**：运行第 20 节全部离线用例、现有测试/构建与适用 desktop smoke；输出基线对比与已知限制。提供显式 opt-in 的真实 A/B 脚本，但不默认执行。

**交付**：实现说明、迁移/回滚说明、测试清单与原始结果、source-map 示例、指标口径、真实测量运行指南。

**退出条件**：不能以“安装了 pi-ai”“新增了缓存设置按钮”或“UI 百分比更高”作为完成。必须用真实待发请求证明机制，产品缓存提升的证据阶段分开报告。

### C09 / 可选：pi-ai backend 对照实验

**依赖**：C00–C08 的核心契约稳定后；不阻塞它们交付。

固定一个经过审查的依赖版本，按 provider/协议窄入口引入，不能直接导入全 catalog 并替换所有现有行为。

适配层必须做到：最终 payload 可观察；每次内部 retry 纳入 UAH attempt ledger 或禁用隐式 retry；没有自发历史修复；保留未知原生数据的 coverage；取消/终态语义一致；不打开未授权认证模式。SDK 生命周期脚本、依赖体积及 Electron 打包要审查。

对同一 canonical fixture，以现有 backend 和 pi backend 分别生成请求/事件，再做语义比较。不同合法表示引入明确 projection version；不能宣称二者字节一致而未比对。

是否采用以维护成本、provider覆盖与测试结果为依据，而不是“DSH 使用了所以必然更好”。

### 推荐合并批次

```text
批次 1：C00，建立原有行为的确定性证据
批次 2：C01 + C02，完成稳定前缀的基础闭环
批次 3：C03 + C04，完成跨 run 历史与缓存 frontier
批次 4：C05 + C06，完成长期任务、日志/UI 和消息接入
批次 5：C07 + C08，迁移、回滚、回归和交付
可选：C09；Android A01–A05 使用已冻结 fixtures 同步
```

---

## 19. 迁移与回滚

### 19.1 特性开关

建议 runtime 配置有 `contextEngineVersion`，可选 v1/v2；shadow compare 是仅构造候选、不发送第二请求的诊断模式。

开关在 session/branch 上固定，避免重启后随机换 engine。缓存策略 profile 独立版本化，不能在请求已准备之后切换。

### 19.2 旧会话一次性升级

1. 暂停在安全边界，要求无未处理的正在执行动作；读取当前权威状态和记录完整度。
2. 沿用现有一致性备份。
3. 从可用原生 frame / 公开证据构造 canonical entries，记录来源与 coverage；不补造已丢失的 reasoning、原始工具输出或历史环境。
4. 引用已提交压缩窗口与排除/修订状态，不从所有 UI 消息重新恢复一遍。
5. 新建 active surface 与 instruction/tool versions；在同一事务提交 migration marker。
6. 验证离线可重建且权限/branch 正确；之后的新真实请求使用 V2。
7. 必要时接受一次明确的重新预热，记录 `migration_recompile`，不把这次与 warm 基准混算。

新会话可以直接 V2；旧数据无法完整迁移时提供公开证据模式并标明限制，不因此删除原日志。

### 19.3 回滚原则

新 schema 保留旧日志可读性，迁移幂等。只有仍可正确表达当前有效历史/删除状态时才允许同 branch 回到 v1；否则将旧版设为只读，或显式导出兼容公共分支，而不是静默丢掉新控制/摘要事件。

不得用旧备份覆盖迁移后发生的新用户动作。程序回滚与用户数据回滚是不同操作，需要现有确认和恢复机制。

### 19.4 数据删除

删除原件、移出上下文与永久删除分别按产品语义处理。任何 active summary / replay / manifest 若会重新暴露已排除内容，应被标记失效或重建。旧日志保留多久、raw 数据能否继续存在由用户已有保留政策控制。

不能以“append-only”为借口拒绝必要的数据删除；append-only 是正常编辑模型，不是无限保留的隐私政策。

---

## 20. 必须具备的测试矩阵

这些是测试要求，不是已生成/已通过的测试。新建测试文件应放入现有 `tests/runtime/*.test.ts` / 对应目录，使当前 npm test glob 能实际收录。

| ID | 场景 | 必须断言 |
|---|---|---|
| T01 | 仅时钟推进 | stable prompt/tools/历史不变 |
| T02 | 同 run 预算消耗递增 | 不将每次精确计数写回系统头 |
| T03 | 新 runId，相同 session | 相同 active surface 谱系，无历史重排 |
| T04 | 纯 UI 状态、端点显示名改变 | 不使回放和缓存域无谓失效 |
| T05 | Git 读取结果相同 | 不追加新快照 |
| T06 | Git 语义改变 | 尾部追加一次；旧快照字节保持 |
| T07 | 状态 A→B→A | 第二次 A 仍应追加，不能全历史 hash 去重 |
| T08 | 状态清空 | 明确 tombstone，旧值不继续生效 |
| T09 | 有效快照被压缩移除 | 在需要时恢复当前快照一次 |
| T10 | 普通重启 | 恢复相同 surface/epoch/frontier；不自动网络调用 |
| T11 | 热更新模型配置 | 在飞行请求不变，下次采用新路由快照 |
| T12 | Plan 进入/退出 | 真实策略更新；旧 system 禁令不残留，权限门正确 |
| T13 | 自定义 prompt 含动态 slot | 迁移/兼容模式有明确行为，不暗改用户指令 |
| T14 | 相同 tools 不同注册顺序 | 固定版本生成相同声明序 |
| T15 | 工具真实新增/移除 | 明确 manifest 变化和合法策略边界 |
| T16 | 并行工具反序完成 | 结果按原调用序输出 |
| T17 | 工具结果缺失/重复 | 拒绝不合法请求，不伪造成功 |
| T18 | 系统更新/relay 来在工具批次中间 | 不拆开调用-结果闭环 |
| T19 | 原生 assistant 包含空 thinking+signature | 兼容路径不因空文本丢掉必要块 |
| T20 | Responses encrypted reasoning | 同域保真；跨域不泄露或误回放 |
| T21 | 同协议不同模型 | 按兼容规则降级，保留通用工具事实 |
| T22 | 同模型不同账号/端点 | 原生隔离不放宽 |
| T23 | 编辑 assistant | 旧签名不能绑定新内容 |
| T24 | native frame 丢失/被脱敏 | 有 coverage 与降级原因，不假称完整 |
| T25 | 工具 ID 字符/长度不合目标协议 | 稳定映射，调用与结果一致 |
| T26 | 不同源重名 tool ID | 冲突检测，不覆盖关联 |
| T27 | 任意普通追加 | 旧输入段内容/顺序保留；允许变化均有解释 |
| T28 | Chat / Responses / Anthropic 编译 | 各自 golden 与 source map 一致 |
| T29 | 未知缓存能力网关 | 不发送猜测 cache 字段 |
| T30 | 缓存只标 system 的错误实现 | 长历史 frontier 验收必须失败 |
| T31 | 显式机制只标最新点 | 旧 frontier 不可匹配时测试失败 |
| T32 | frontier 旧点+新点 | 老点仍完整，新点为下一次候选 |
| T33 | 断点跨度超过 profile 回看范围 | 安排可查找旧边界，不按 UI 气泡计数 |
| T34 | 断点数量达上限 | 合法去重/取舍，不造成非法 body |
| T35 | thinking/空文本等不合法标记点 | 选择合法点或明确跳过 |
| T36 | TTL 配置冲突 | 请求前拒绝，不能无限降级重试 |
| T37 | 重启后旧 frontier | 内容和 route 兼容才恢复为候选，不宣称服务端必热 |
| T38 | 前沿被摘要/删除覆盖 | 失效；仍保留前面合法稳定锚点 |
| T39 | 标记位置改变但内容未变 | 分离 cache topology 变化与内容前缀破坏 |
| T40 | DeepSeek 标准/专有/两者同时出现 | 正确映射，不相加；冲突有诊断 |
| T41 | Anthropic cache read/write/input | 保持正确总输入，不重复计费 |
| T42 | OpenAI cache-write 明细 | 依据 schema 识别，不把 write 当 read |
| T43 | streaming 累计 usage 多次出现 | 同 attempt 更新，只结算一次 |
| T44 | 请求取消且无终态 usage | partial/unknown，不补零，不漏 attempt |
| T45 | 网络重试无新增输入 | 同 request 新 attempt，body语义/entry不重复 |
| T46 | 重试期间新 steering 需要纳入 | 新逻辑 request，不修改已发请求 |
| T47 | token 与 body byte 限制不同 | 分开 admission reason，错误清楚 |
| T48 | 中文/代码/JSON/opaque 混合 | meter source/uncertainty 明示，无整数溢出 |
| T49 | 单个长期 run 达到阈值 | 可选早期已闭合 exchanges，不永久保护全 run |
| T50 | 摘要失败、空、过长、截断 | 不提交，旧 surface 不变 |
| T51 | 摘要返回工具调用 | 不执行，不当作正常摘要 |
| T52 | 压缩期间选择范围被编辑 | CAS 拒绝，不覆盖新修订 |
| T53 | 压缩期间只追加新尾部 | 首期安全拒绝或经测试合并，不能丢尾 |
| T54 | 提交阶段磁盘/数据库失败 | 原子性；旧或新完整状态，不出现半提交 |
| T55 | 已压缩后新 run/重启 | 保留新窗口，不再次载入被覆盖原文 |
| T56 | provider overflow 无实际缩减 | 有限停止，不重复同一输入 |
| T57 | 工具首次输出被限长 | 完整 artifact 可分页；首份模型视图后续不变 |
| T58 | 工具效果未知 | 结构化证据与恢复阻断保留 |
| T59 | 子代理中途报告 barrier | child未结束，父下一实际body已含report |
| T60 | report 重试/重复受理/恢复 | 一份entry；投递证据不等于已阅读 |
| T61 | 父暂停/停止时报告 | 不唤醒、不放宽权限、按原消息计划处置 |
| T62 | 排除/删除原文后摘要仍含信息 | 摘要/投影失效，不复活内容 |
| T63 | 旧数据重复迁移 | 幂等，无重复entry、无付费请求 |
| T64 | 日志捕获关闭或原件脱敏 | 相应coverage真实；不可借日志开关绕过必要审计 |
| T65 | observer记录失败 | 按现有规则停止，不误当provider失败自动重试 |
| T66 | 大量长历史准备/落盘 | 无每run重复全历史存储放大；基准结果可复核 |
| T67 | SDK内部重试（C09适用） | 每次实际调用记账或明确禁止 |
| T68 | SDK隐式工具修复（C09适用） | 不绕过UAH事实/副作用规则 |

### 推荐测试命令

基线 package.json 已存在下列命令；是否适用具体环境由实施代理核对，不应声称本计划已经执行。[S20]

```text
npm run typecheck
npm test
npm run build
npm run test:desktop
npm run test:tool-chat
npm run test:turn-actions
npm run test:plan-mode
npm run test:git-context
```

涉及 Windows 执行器的回归，在适用 Windows/.NET 环境执行既有 native tests；本轮不改变命令权限和 Job Object 生命周期。

建议新增 `test:context`、`bench:context`、`bench:cache-live` 三类脚本。前两者默认离线；最后一个要求显式 live 开关、选定 endpoint/model、最大请求数与费用/预算上限，缺省拒绝执行。它们是待新增脚本，不是当前仓库已有命令。

---

## 21. 最终交付物与完成报告

实施代理最终应交付：

- 已合入的代码与逐批提交说明，指出基线差异及保留的既有机制。
- context/replay/cache profile 的 JSON fixtures，以及 T01–T68 的覆盖映射。
- 旧版与新版最终请求的脱敏比对，明确最早变更点和恢复/压缩边界。
- 基准原始数据：请求数、用途、input/cache-read/cache-write、coverage、TTFT、body bytes、准备时间与存储增量。
- schema migration / rollback / 隐私删除说明，未执行付费测试的明确状态。
- 运维说明：怎么看低命中是前缀破坏、断点错误、冷启动/TTL，还是上游未知。

完成报告必须分别写：

`机制验收：通过/不通过`；`真实provider验证：未运行/已运行及样本条件`；`生产缓存收益：暂无证据/已测结果`。

不得把本地模拟器的合成缓存数据、理论公共前缀比例或测试断言当成实际 provider 的缓存命中证明。

---

## 22. 源码和官方文档索引

以下 [Sxx] 是本计划引用的证据或实施前应复核的直接来源。源码事实以固定快照为准；所有新增接口、工作包、目标阈值和测试编号均为 UAH 的设计建议，不代表 DSH/pi 已有同名实现。

[S01] UAH-desktop 固定提交与提交说明：
https://github.com/LingYzh/UAH-desktop/commit/629196a0328e66eba691a0f928a9f8536c990505

[S02] deepseek-harness 固定快照：
https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc

[S03] pi 固定提交：
https://github.com/earendil-works/pi/commit/200387122ca450d6387f033949423114a270b96c

[S04] AgentApp Android 上轮核查快照：
https://github.com/LingYzh/AgentApp/tree/90fa0e60a63bb12320351836b5bfde787649aeae

[S05] 桌面动态 runtime context：
https://github.com/LingYzh/UAH-desktop/blob/629196a0328e66eba691a0f928a9f8536c990505/src/runtime/prompt-context.ts

[S06] 桌面提示组装与请求循环：
https://github.com/LingYzh/UAH-desktop/blob/629196a0328e66eba691a0f928a9f8536c990505/src/runtime/prompt-assembler.ts
https://github.com/LingYzh/UAH-desktop/blob/629196a0328e66eba691a0f928a9f8536c990505/src/runtime/supervisor.ts

[S07] 桌面 API request body / streamAgentApiInternal / prepared observer：
https://github.com/LingYzh/UAH-desktop/blob/629196a0328e66eba691a0f928a9f8536c990505/src/runtime/api-transport.ts

[S08] 同一 API transport 内的 appendToolResults / AgentStreamAccumulator.usageEvents；请直接定位函数，不将全文变化视为该函数已变化：
https://github.com/LingYzh/UAH-desktop/blob/629196a0328e66eba691a0f928a9f8536c990505/src/runtime/api-transport.ts

[S09] 桌面 ModelFrame 兼容回放和公开证据 fallback：
https://github.com/LingYzh/UAH-desktop/blob/629196a0328e66eba691a0f928a9f8536c990505/src/runtime/model-history.ts

[S10] 桌面准入、公开历史投影与可见上下文捕获：
https://github.com/LingYzh/UAH-desktop/blob/629196a0328e66eba691a0f928a9f8536c990505/src/runtime/context-governor.ts
https://github.com/LingYzh/UAH-desktop/blob/629196a0328e66eba691a0f928a9f8536c990505/src/runtime/context-compaction.ts
https://github.com/LingYzh/UAH-desktop/blob/629196a0328e66eba691a0f928a9f8536c990505/src/runtime/request-context.ts

[S11] DSH SystemPromptProjection / RuntimeContextProjection：
https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/src/runtime-context.ts

[S12] DSH 统一 LLM 边界与 pi-ai 依赖范围：
https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/llm/llm/README.md
https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/llm/llm-pi-ai/package.json

[S13] DSH pi-ai context 和 replay：
https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/llm/llm-pi-ai/src/context.ts
https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/llm/llm-pi-ai/src/replay.ts

[S14] DSH DeepSeek Messages serializer：
https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/llm/llm-deepseek/src/serialize.ts

[S15] DSH 压缩机制说明：
https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-basic/README.md

[S16] pi transformMessages：
https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/ai/src/api/transform-messages.ts

[S17] OpenAI 官方 Prompt caching（2026-10-04 查询；具体模型/API 字段应再次核对）：
https://developers.openai.com/api/docs/guides/prompt-caching

[S18] Anthropic 官方 Prompt caching（2026-10-04 查询）：
https://platform.claude.com/docs/en/build-with-claude/prompt-caching

[S19] DeepSeek 官方 Chat Completions usage 字段（2026-10-04 搜索返回文档内容；直接打开端点存在工具访问失败）：
https://api-docs.deepseek.com/api/create-chat-completion/
补充：官方缓存字段介绍（历史发布，仅用于字段渊源，不使用其旧价格）：
https://www.deepseek.com/en/news/context-caching/

[S20] 桌面 npm scripts：
https://github.com/LingYzh/UAH-desktop/blob/629196a0328e66eba691a0f928a9f8536c990505/package.json

[S21] 用户既有交接文档（Library，本轮检索确认）：
`UAH_AgentApp_Harness_Upgrade_Plan_2026-10-01_v1.1.md`
`UAH_Subagent_Intermediate_Messaging_Plan_2026-10-03.md`
前者要求完整日志和逐请求 ledger 纳入 P0；后者要求安全边界真实投递，不只是 UI 进度。实现时优先读取仓库内最新已接受副本。

[S22] Android 对应实现（上轮核查基线）：
https://github.com/LingYzh/AgentApp/blob/90fa0e60a63bb12320351836b5bfde787649aeae/app/src/main/java/com/example/myapplication/agent/AgentEngine.kt
https://github.com/LingYzh/AgentApp/blob/90fa0e60a63bb12320351836b5bfde787649aeae/app/src/main/java/com/example/myapplication/agent/ContextCompactor.kt
https://github.com/LingYzh/AgentApp/blob/90fa0e60a63bb12320351836b5bfde787649aeae/app/src/main/java/com/example/myapplication/provider/AnthropicProvider.kt

---

## 23. 结论

优先级不是“先换成 pi-ai”，而是：**先让 UAH 的会话输入形成稳定、可恢复、带来源的公共前缀，再让每个 provider 的缓存策略正确读取旧历史 frontier 并写入新 frontier。**

首轮必须同时看三个层面的证据：system 是否还在逐轮变化、历史是否跨 run 保真连续、断点是否真正覆盖了不断增长的历史。之后用事务压缩、来源回放、真实用量和可解释 trace 保证长期对话不会再次退化。
