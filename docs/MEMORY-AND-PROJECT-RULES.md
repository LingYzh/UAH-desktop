# UAH 项目规则与独立记忆

实施契约：2026-10-03。用户已确认经济型子代理配置、UAH 独立记忆、项目 `.memory`、用户 `~/.uah/memory`，原生运行时继续采用自身机制。

## 实施范围

用户明确不需要记忆的 UI 表现。本功能不增加管理界面、入口、专用 IPC 或共享组件，使用模型工具与 Markdown 文件维护。既有请求记录自然包含实际发送的规则及记忆上下文；既有工具审批继续适用。

## 读取规则

- 仅 UAH API 路径自动装配。原生 Codex 的配置、指令、工具及记忆加载不因本功能改变。
- 已授权会话目录为规则查找边界。根目录及实际涉及的子路径分别选主规则，不遍历全项目正文，也不越界读取上级目录。
- 同作用域候选 AGENTS.md、CLAUDE.md、.claude/CLAUDE.md、CLAUDE.local.md 按修改时间取有效主文件，平局固定顺序；AGENTS.override.md 有效时替代同目录 AGENTS.md。其余记录来源供按需读取。mtime 仅是默认入口选择，不代表语义更新日期。
- 显式、安全的项目内 @引用可有界展开；普通文档链接按任务读取。拒绝越界及链接路径；范围、错误、截断或未支持语法必须可见。不同作用域按由浅到深排列，当前用户要求和实际宿主权限优先。
- 各次请求重新获取快照；工具首次涉及新子目录时，在执行之前将该作用域规则送回模型重新决策，不能写完再补规则。
- 外部 ~/.claude 与 ~/.codex 默认只发现白名单来源元数据；正文只经按需搜索/读取，绝不遍历认证、配置、会话历史或内部数据库。

## 独立 Markdown 记忆

- 用户记忆 ~/.uah/memory；项目记忆 <workspace>/.memory；本机私有项目记忆 ~/.uah/memory/projects/<project-id>。
- Markdown 为正文权威。索引可重建，手工修改立即影响后续读取；读取不创建目录，首次写入才初始化。
- 自有条目使用稳定 ID、版本化元数据、标题、类型、状态、作用域、来源与时间。MEMORY.md 的宿主管理区块之外保留用户文字；任意已有 Markdown 可按需读取，未经版本校验不覆盖。
- 项目短索引与用户固定的有效偏好按次提供；普通用户/私有项目正文及其他专题按需检索。历史经验不能升级为宿主指令或当前状态。
- 模型通过实际注册的记忆工具提取并保存候选，不增设隐藏付费总结请求。候选及证据保持可辨；用户可在对话中要求确认/固定，由 save_memory 的 active/pinned 参数触发既有工具审批，实际批准后才记录为用户确认（包括 bypass 模式）。也可手工编辑 Markdown 元数据。子代理不能自动发布长期记忆。
- 写入/遗忘遵守当前权限和审批；readonly/Plan 不提供记忆写工具。项目写入遵循工作区模式；用户和私有项目目录在工作区之外，除 bypass 外使用既有工具审批。
- 写入使用内容哈希检查、进程内串行和原子替换。拒绝链接/硬链接/越界。不声称隔绝任意外部程序的并发修改。
- 遗忘保留无正文墓碑，避免旧内容被自动再次提取；不自动更改 .gitignore、不提交文件、不操作其他 harness 的记忆目录。

## 验收

临时 home/项目 fixture 验证：规则排序/平局/局部作用域、显式导入、超限、全局首轮零正文、按需检索、Markdown 重启读取与手工编辑、CAS、遗忘去重、权限审批、API 三协议实际请求、原生不注入、来源快照。没有新增 UI，因此没有本功能专用视觉验收。测试不得污染真实用户目录或调用真实 provider。

## 工具与文件

`list_context_sources` 列出来源；`search_context` 默认只检索 UAH 自有记忆，传入外部 sourceIds 才检索外部资料；`read_context` 按来源读取并返回正文哈希与分页游标。`save_memory` 新建/更新条目，`forget_memory` 写入墓碑。工具只接受宿主返回的来源 ID，写入来源和证据 ID 由运行时填写，模型不可伪造。

```text
~/.uah/memory/
  MEMORY.md
  2026-10-04-preferred-language.md
  projects/<project-id>/
    MEMORY.md
    2026-10-04-local-build-notes.md
<workspace>/.memory/
  MEMORY.md
  2026-09-25-pc-prototype-windows-scopes.md
  notes.md                 # 普通手写 Markdown 可按需读取
```

project-id 由规范项目路径摘要生成，不同 worktree 私有记忆分开。自有条目首行为 `<!-- UAH_MEMORY:{...} -->` JSON 元数据，空行后为 Markdown 正文；元数据含 formatVersion、id、title、scope、kind、status、pinned、createdAt、updatedAt、source、contentDigest。文件内容哈希按实际字节重新计算，手工改动会使旧 expectedHash 失效。仅 `status=active`、`scope=user`、`kind=preference` 的条目可以 pinned。索引的 `UAH_MEMORY_INDEX:START/END` 区块由宿主管理，其余内容保留。

例如，对话要求“记住本项目的构建约束”可生成候选；“确认并固定刚才的语言偏好”可发起已有工具审批，批准后成为自动提供的用户偏好；“忘记这条经验”先读取版本再遗忘。实际是否提炼由正常模型轮次决定，不保证每轮都生成记忆。候选仍可检索，但不是已确认的事实。

### 可读文件名（2026-10-04）

新建条目采用宿主本地创建日期 `YYYY-MM-DD-主题.md`。`save_memory` 可提供简短英文 `slug`（小写字母、数字、单连字符，至多 80 字符）；省略时从标题生成，保留中文等文字。名称冲突追加 `-2`、`-3`，不会覆盖已有自有或手写文件。UUID 仅作为元数据中的稳定 ID；更新仍使用 ID 和 expectedHash，普通更新不改文件名，不能传 slug。

旧 `<uuid>.md` 保持兼容，不批量迁移用户文件。索引链接使用真实文件名；重复元数据 ID 显式报错，不能任意挑选。遗忘先清除正文与标题，再把文件改为 `YYYY-MM-DD-forgotten-memory.md`（冲突加序号），避免主题残留在文件名。部分提交失败如实报告并要求核对，不能重试成重复记忆。

## 隔离与边界

- 桌面正常启动使用操作系统用户目录；`UAH_MEMORY_HOME` 可指定用户目录根（其下使用 `.uah/memory`）。设置 `UAH_DATA_DIR` 的隔离桌面测试默认使用该数据目录下 `context-home`。独立构造 Supervisor 未提供 homeDirectory 时也使用数据目录下 context-home，避免测试误读真实用户资料。
- 文件工具明确给出的 path 可触发子目录规则发现。任意 shell/MCP 的内部文件访问不可可靠推断，因此模型必须先读涉及路径；本功能不宣称是操作系统文件访问拦截器。
- 原有 Claude/GPT 完整绑定提示词继续作为精确迁移来源保留；新能力通过 prompt-assembler 条件模块与 prompt-context 实际注册结果声明，不重写历史默认文本。
