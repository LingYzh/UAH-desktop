# Codex CLI 0.157.1：原版提示词与第三方 harness 适配包

核查日期：2026-09-27。发布版本：`0.157.1`（正式版，2026-09-26T01:02:31Z 发布）。

固定来源：OpenAI 官方 `openai/codex` 仓库，标签 `rust-v0.157.1`，提交 `36650394c5b38c2990ccf2a3457165ca3e9d9726`。

## 先选文件

| 使用场景 | 文件 | 说明 |
| --- | --- | --- |
| 第三方 harness 的主代理 | `portable/main.system.md` | 完整适配版；替换占位符后使用 |
| 第三方 harness 的子代理 | `portable/subagent.system.md` | 完整适配版；包含公共基座与子代理角色 |
| 模块化组装 | `portable/shared-base.md` + `main-role.md` 或 `subagent-role.md` + `runtime-context.md` | 与完整适配版内容一致；不要重复加载公共基座 |
| 给 `codex exec` 固定基础指令 | `original/gpt-6-astra.base.md` | 模型目录中的英文基础指令；用于 `model_instructions_file` |
| 研究主代理角色增量 | `original/gpt-6-astra.root-role.md` | 模型目录中的 root 角色文本；不是完整系统提示词 |
| 研究子代理角色增量 | `original/gpt-6-astra.subagent-role.md` | 模型目录中的 subagent 角色文本；不是完整系统提示词 |
| 阅读基础与角色的组合 | `original/gpt-6-astra.main.assembled.md` / `gpt-6-astra.subagent.assembled.md` | 本包组装，正文为基础原文 + 对应角色原文；不包含完整运行时 |
| 研究多代理运行时 | `original/multi-agent.*` | 从 Rust 常量提取的原文；存在条件开关，不应全量无条件注入 |
| 查阅无模型覆盖时的角色 | `original/bundled/` | Rust 内置角色回退文本；不要误当作 Astra 的实际角色覆盖 |
| 导出其他模型或另一份实际目录 | `scripts/export_originals.py` | 支持官方固定快照、本地 checkout、显式指定的本地目录 JSON |

本包预制的模型原文对应 `gpt-6-astra`。这不是声称所有模型都使用该提示词，也不是声称每个账号都能选择该模型。`gpt-6-sol`、其他 GPT 模型或第三方模型，应从各自目录条目提取；不要仅根据 CLI 版本认定它们的系统提示词相同。

## 为什么不是一个通用 system.md

0.157.1 的相关来源分布如下：

1. `codex-rs/models-manager/models.json`：各模型的 `model_messages.instructions_template`，以及 `model_messages.multi_agent.role.root` / `.subagent` 等覆盖项。
2. `codex-rs/prompts/src/model_instructions.rs`：从模型元数据返回字面量基础指令。该实现不会自行展开 `instructions_variables`。
3. `codex-rs/prompts/src/model_messages/multi_agent.rs`：选择模型角色覆盖，缺失时使用 Rust 内置角色文本；显式空字符串也算覆盖。
4. `codex-rs/prompts/src/multi_agent_instructions.rs`：把角色文本和运行时能力组合成单独的 developer 消息，按条件添加共享目录说明、等待说明、并发容量与模型覆盖限制。

除此之外，还有权限、协作模式、技能、项目指令、工具 schema、环境与会话状态。它们不能靠一份静态 Markdown 准确代表每次调用。

`original/` 的“原文”指可公开核对的源文本，不是从你的账号抓取的完整实际请求。原始 JSON 转义已还原成可读文本。基础与角色提取文件没有加入作者自己的工程规则；`assembled` 文件的组合动作来自本包，不是上游的同名文件。代码中的 `{max_concurrency}` 是上游 Rust 格式化槽位，不是已经填好的并发值。

没有把旧 `core/gpt-5.2-codex_prompt.md`、通用回退 `prompt.md` 或 `orchestrator.md` 冒充所有当前模型的唯一默认提示词。也没有把 persistent mode、Guardian 审批分类器等条件启用模块混入普通主代理基座。

## 第三方适配版改了什么

适配版保留源文的英文主体、章节顺序和主要行为：按已授权任务主动推进、不反复询问已授权事项、跨轮保持目标、解释实际阻塞、表达清楚、按实际需要测试，以及按相关性使用技能和插件。

替换为占位符的内容包括：Codex/GPT 身份、工作区关系、消息通道、异步提问、自动压缩假设、文件链接渲染、工具名称与调用路径、技能与连接器发现协议、子代理身份、消息封包、上下文分叉、共享目录、并发限制、等待与模型覆盖策略。

另外添加了标明为 `Host compatibility contract` 的宿主兼容约定：遵循实际指令层级与权限，不虚构工具、自动记忆、后台工作或执行结果。子代理还明确以被委派的任务为目标，并由宿主定义返回父代理的机制。这些是适配补充，不冒充上游原文。

对照改动可查看 `evidence/base-adaptation.diff`、`root-role-adaptation.diff`、`subagent-role-adaptation.diff`。没有增加“所有任务必须计划”“必须调用子代理”“只能有一个写代理”这样的固定流程；并发与读写约束由你的宿主填写。

### 占位符填写

`PLACEHOLDERS.zh-CN.md` 解释所有槽位。`examples/bindings.empty.json` 是待填骨架，不是可运行默认配置。

不存在的能力请明确填写“该能力未提供，禁止调用/假定存在”；相应不适用的整节也可以直接删除。不要把 `{{TOOL_USAGE_INSTRUCTIONS}}` 之类当作工具名。

示例：

```bash
python scripts/render_portable.py portable/main.system.md my-bindings.json out/main.system.md
python scripts/render_portable.py portable/subagent.system.md my-bindings.json out/subagent.system.md
```

脚本只做一次大写占位符替换，缺失或空值会报错，不递归解释插入的工具定义与任务文本。输出默认不覆盖已有文件。

运行时消息在宿主能区分 system / developer / tool schema / user context 时，应按真实层次分别注入。两个 `.system.md` 是便于只有一个提示词入口的宿主使用的平面组合，不会创建一套假的 Codex 协议。

## codex exec 的正确加载方式

### 1. 使用 Codex 自己当前选中的原生提示词

不指定覆盖文件即可。读取任务可以保留默认只读模式；需要修改工作区时显式指定写入模式。

```bash
codex exec --sandbox workspace-write "实现任务并执行与改动相称的验证。"
```

这条路径由 Codex 自己按模型、配置和运行时组装提示词。通常比人为重复粘贴原文更合适。

### 2. 固定本包的基础原文

在你的账号/供应商确实支持 `gpt-6-astra` 的前提下，可以按对应模型运行：

```bash
codex exec --model gpt-6-astra \
  -c 'model_instructions_file="/absolute/path/codex-cli-0.157.1-prompts/original/gpt-6-astra.base.md"' \
  --sandbox workspace-write \
  "这里是本次任务，不是系统提示词。"
```

PowerShell 示例（实际路径需替换，正斜杠避免 TOML 反斜杠转义）：

```powershell
codex exec --model gpt-6-astra `
    -c "model_instructions_file='E:/prompts/codex-cli-0.157.1-prompts/original/gpt-6-astra.base.md'" `
    --sandbox workspace-write `
    "这里是本次任务，不是系统提示词。"
```

`model_instructions_file` 替换的是基础指令，不会替换全部 developer 消息、AGENTS.md、工具定义、权限及环境。不要把同一份基础正文再追加到 AGENTS.md。不要仅将几行 `subagent-role.md` 填入这个设置，导致完整基座被替掉。原生多代理的角色由运行时负责，通常不应再把 `main.assembled.md` 作为基础文件，以免重复角色指令。

不同模型必须使用其对应的基础原文；保留 Astra 的 GPT-6 自述再给另一种模型使用，不是忠实的原生重放。

### 3. stdin 是任务输入，不是基础指令覆盖

```bash
codex exec - < task.md
```

这里 `task.md` 是用户任务提示。把系统提示词放在这里并不等于替换 system/developer 层。需要基础覆盖仍使用 `model_instructions_file`。

### 4. 外部 harness 把 codex exec 当作执行型子代理

例如保留 Codex 原生基座，把委派任务、范围和回传格式放在 `task.md`：

```bash
codex exec --sandbox workspace-write --json -o result.md - < task.md > events.jsonl
```

`--json` 输出事件流，`-o` 单独保存最终结果。父 harness 负责提供任务、解析事件、读取最终文件及管理取消/超时。独立启动的 `codex exec` 不是原生 `spawn_agent` 子线程；仅粘贴 `/root/...`、`send_message` 或“final 自动返回父代理”的提示词，不能创造不存在的父子通信。

本包没有替你连接账号或执行付费模型调用。`examples/exec-task-bridge.md` 是外部委派的任务模板，不是上游原始系统提示词。

## 导出别的模型与核验原文

脚本默认下载这个包固定提交的官方公开 `models.json`，并校验其 Git blob SHA，再按模型导出基础、角色、组装阅读版和模型消息 JSON。不会请求模型，也不会上传本地文件。

```bash
# 列出固定快照包含的准确模型 ID
python scripts/export_originals.py --list

# 从固定快照导出全部模型
python scripts/export_originals.py --output upstream-export

# 只导出已确认存在的模型；可重复 --model
python scripts/export_originals.py --model gpt-6-astra --output astra-export

# 从已下载/已有 checkout 读取，完全离线
python scripts/export_originals.py --repo /path/to/codex --output offline-export

# 显式使用另一份含 models 数组的实际目录 JSON，不把它标成固定快照
python scripts/export_originals.py --catalog /path/to/models.json --output actual-catalog-export

# 将包内三个 Astra 原文与官方固定快照做字节级比较
python scripts/export_originals.py --verify-pack
```

这里的 Git blob SHA 校验针对原始 `models.json` 文件；本包 `MANIFEST.sha256` 仅供校验交付文件是否改变，不能当作“已经与上游逐字节验证”的证据。

本轮通过官方 GitHub 读取接口核对并转存了源文，但当前运行环境无法直接联网下载原始字节，也没有可运行的 Codex CLI。因此：没有宣称已完成模型目录原始字节与三个转存文件的独立比对，也没有宣称运行过真实 `codex exec`。附带的 `--verify-pack` 可在可联网环境独立检查；也可把通过官方途径下载的目录传给 `--catalog` 完成比较。随包测试覆盖了本地渲染、模型目录解析、字面量保留和空值回退规则，详见 `VALIDATION.md`。

## 来源与许可

- 固定发布：https://github.com/openai/codex/releases/tag/rust-v0.157.1
- 模型目录：https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/models-manager/models.json
- 基础解析：https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/prompts/src/model_instructions.rs
- 模型覆盖解析：https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/prompts/src/model_messages.rs
- 角色回退：https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/prompts/src/model_messages/multi_agent.rs
- 运行时组装：https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/prompts/src/multi_agent_instructions.rs
- 非交互用法：https://developers.openai.com/codex/noninteractive
- 配置参考：https://developers.openai.com/codex/config-reference
- 子代理配置：https://developers.openai.com/codex/multi-agent

上游许可为 Apache-2.0，包内包含许可证副本及保留的上游 NOTICE。原文版权归原权利人；本包的适配、组装、说明和工具脚本不是 OpenAI 官方发布。源自上游的改动在文件头和 diff 中标明。
