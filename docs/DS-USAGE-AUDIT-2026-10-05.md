# DS 用量与客户端展示核对

会话：`63dc2434-f2ee-4561-98f3-2383a7e928cc`。2026-10-05 只读调查，未修改业务代码／用户数据，未发送新模型请求。

## 结论

UAH 账本与用户提供的 DS 后台截图完全一致。显示差异来自单次请求与累计会话两个统计范围。客户端截图显示第 3 个用户回合的第 6 次请求，不是整个会话；当前选择器实际上每个 run 只显示最后一份请求快照。

从真实 Roaming runtime.sqlite 的宿主侧只读备份取得 2806 个事件。3 个根 run，共 11 个 requestId、11 个 attemptId，11 个 dispatch 与 terminal，无重试、子代理或 compaction 请求。22 个 usage.snapshot 是每次请求先 unknown、后最终值；按 attemptId 取最新 revision，不能直接相加全部快照。

| 项目 | UAH 11 次请求汇总 | DS 截图 |
| --- | ---: | ---: |
| 缓存输入 | 197888 | 197888 |
| 未缓存输入（总输入减缓存输入） | 21052 | 21052 |
| 总输入 | 218940 | 218940 |
| 输出 | 10534 | 10534 |
| 输入与输出合计 | 229474 | 229474 |

会话缓存命中率 = 197888 / 218940 = **90.38%**。不能用包含输出的 229474 作输入缓存命中率分母，也不能平均各请求的百分比。

客户端最后一次请求 input=28883、cache=28032、output=2003，28032/28883=**97.05%**，该单次值也正确。

## 命中率与前缀

首请求 input=13718、cache=0；它占全部未命中输入的 65.16%。排除首请求后，其余 10 次合计命中率为 **96.43%**。首请求为何在服务端没有既有缓存，仅凭这些记录不能进一步确定。

已读取并校验 11 份 context.request manifest 的 SHA-256。instructionHash、toolManifestHash、routeKey、epoch 全程各只有一个值；10 个相邻转换均 appendOnly=true、firstChanged=null。独立比较各份有序 segment 列表，旧列表始终是下一份前缀，10/10 通过。该会话没有发现记忆变化重写头部或持续破坏前缀的证据。

DS Responses 原始 usage 提供 input_tokens、input_tokens_details.cached_tokens、output_tokens、reasoning_tokens、total_tokens；没有独立 cache-write/miss 字段，故账本 completeness=partial。partial 不代表已提供的 input/cache/output 不可信。未命中输入在本报告中由总输入减 cache 推导，没有改写原始账本。输出沿用服务端 output_tokens，没有再叠加 reasoning_tokens。

## 下次实施事项（用户要求，本次不改）

- 上下文详情改为会话级入口，不再要求按用户回合选择。
- 会话累计输入、缓存输入、未缓存输入、输出及按输入加权的命中率，应从全部 attempts 的最终 usage 汇总，包含适用的子调用／摘要／重试并明确范围；缺失字段不能补零。
- 当前上下文占用与剩余容量仍描述最新有效窗口，不能把累计 218940 输入当成同时占用的上下文；累计用量与当前窗口在同一会话详情内清楚区分。
- 可见内容的本地估算与服务端实际 usage 继续区分。

证据：`artifacts/ds-audit-20261005/usage-audit.json`（逐请求原始 usage 与汇总）、`manifests.json`（校验过的前缀元数据）。真实数据路径存在 MSIX Roaming 虚拟化，沿用上一轮宿主侧只读 backup 方法；本次未访问密钥数据库。
