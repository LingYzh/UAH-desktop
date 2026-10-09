# UAH 图标协议适配评估：UI 0.5.0

交接副本来自 UI 仓库发布后评估。续作以 `docs/HANDOFF.md` 顶部与实际 Git/依赖状态为准；本次 handoff 推送前对仍消费 0.4.2 的 UAH 进行的门禁检查，另见 `docs/VALIDATION.md`，不能替代未来 0.5.0 适配验收。

评估日期：2026-10-09。UAH 当前 main 保持官方 `@lingyzh/ui@0.4.2`，工作区干净。本轮没有升级 UAH 依赖，也没有修改其生产代码。

## 结论与建议范围

推荐下一批完成两件事：固定升级官方 UI 0.5.0，并将 UAH 自有 `Icon.vue` 改成共享 `UiIcon` 的薄包装。保留现有 `name/size` 调用，避免逐页替换图标；需要 MDI 时再通过 `icon` 传具名路径。

如果只升级 UI，当前 UAH 调用没有发现必须重写的协议冲突；但其自有 Icon 仍使用旧解析与未知名称回退，尚不能称为 UAH 全部图标协议统一。

| 项目 | 应如何处理 | 判断依据 |
|---|---|---|
| UI 依赖 | `package.json` 固定为 `0.5.0`，从官方 registry 正常安装并更新 lock；验证 integrity、非 link 目录、单一 Vue，保留其他依赖锁元数据 | 当前仍为 0.4.2；升级是消费本版能力的必要步骤 |
| 自有 Icon | 推荐本批改为共享 `UiIcon` 薄包装，保留 `name` 必填、默认 `size=18`、样式与装饰性 ARIA；新增 `icon/path/label` 的转发能力 | 34 处调用集中在 4 个 SFC；双方 67 个本地 SVG 文件逐字节相同，UAH 无独有资产需要另设字典 |
| 未知名称 | 薄包装采用库的开发警告与留空行为；有意显示文件图标的业务显式传 `file` | 当前可枚举的 29 个名称及动态有限映射均存在，无已知调用依赖未知名称回退 |
| 按钮 | 维持现有调用；补实际 SVG 与插槽显示回归 | 142 个 UiButton 中仅 2 处裸布尔 `icon`，均在默认插槽放自有 Icon；没有字符串 icon 与默认插槽冲突 |
| 共享图标消费者 | 保留 EndpointManager、RunActivity、RunActions 的本地名称 | 模型能力 8 个名称、活动 5 个名称、回复操作 5 个名称均在库中；裸 `copy/edit/close` 不会被默认 `$alias` 抢占 |
| Tabs | 保留元数据和自定义插槽 | 两处 Tabs 的实际图形来自默认插槽，不依赖新的路径解析 |
| `@mdi/js` | 当前业务无需新增直接依赖；开始具名导入时再固定声明 `7.4.47` | UAH 源码没有 MDI 导入或 `mdi-*` 名称；现有版本仅由 UI 间接依赖，不能当作业务稳定依赖 |
| `createUI` | 无需为了升级强制安装插件；有应用别名/自定义图标集需求时再配置 | 显式导入的共享组件自带默认解析，UAH 当前无图标集配置 |

## 薄包装实现要点

- 修改集中在 `src/renderer/components/Icon.vue`，删除运行时重复 eager SVG 字典，转发至 `@lingyzh/ui` 的 `UiIcon`；保留 34 处现有调用。
- 包装组件不要再增加一层 `.prototype-icon` 外壳，让类、事件与 ARIA 落在共享图标根节点，避免双重尺寸或边距。
- 现有 CSS 使用 `.prototype-icon svg` 后代选择器，不要求 SVG 必须是直接子节点；仍需验收共享组件新增的内部 markup 层。
- 原型 `design/` 中的 SVG 属于设计资产，可保留；收敛的是应用运行时实现。
- 保持本地图标的原有线条风格，不把全部业务图标批量换成 MDI。

## 必须验证的界面

1. 标题栏折叠按钮、SearchDialog 关闭按钮：布尔 `icon` + 默认插槽、SVG 存在、尺寸居中、可访问名称、明暗主题与 800px 布局。
2. 模型能力图标：图片/PDF/音频/视频/工具/推理/流式与输出映射，名称、tooltip 和条件显示。
3. 回复操作：copy/edit/branch/refresh/trash 图形和复制、编辑、分支、重新生成、删除行为。
4. 工具及推理活动：图标、状态、展开收起，明暗主题。
5. 输入与复制：新默认 `$clear/$copy/$complete` 等内部图标，尺寸与原有键盘/焦点行为。
6. 升级后提交前按 UAH 约定执行完整 typecheck、test、build、test:ui；专项至少 appearance、endpoints、turn-actions、tool-chat。保留原有 smoke/browser 等消费门禁覆盖与所有首次失败记录。

建议补一项共享图标薄包装测试，断言已知本地名称、MDI 路径、别名和未知名称留空；桌面用例同时断言按钮内真实 SVG，避免仅通过按钮文字或行为漏掉图标缺失。

## 本轮证据与边界

- 只读扫描 UAH main：自有 Icon 34 处、UiButton 142 处、直接 UiIcon 1 处；未发现字符串按钮 icon 冲突；双方 67 个 SVG 内容相同。
- UI 本地 tarball 已通过公共 exports、普通安装目录、单一 Vue 与 9 项 SSR 消费检查。
- 使用 UAH 已安装的 Vite 8.3.3、plugin-vue 6.0.9、TypeScript 7.0.2 文件适配器和 Vue 3.5.43，构建代表性 SFC 消费夹具通过。夹具覆盖 MDI 路径、组件、多路径、旧 name、布尔图标按钮、输入插槽、Activity 与 MessageActions。
- 以上消费检查在独立临时目录中进行，不等于 UAH 生产应用已升级或通过完整运行时验收。正式发布及正式包消费结果见下方。

## 源码定位

- `src/renderer/components/Icon.vue:9–19`：重复字典及未知名称回退。
- `src/renderer/App.vue:215`、`components/SearchDialog.vue:58`：两处布尔图标按钮。
- `components/EndpointManager.vue:70–74,213`：模型能力映射及共享 UiIcon。
- `components/RunActions.vue:16–20,56`：回复操作图标。
- `src/renderer/styles.css:69–86`：图标容器及 SVG 样式。
- `vite.config.ts`：已有 TS 7 文件访问适配器与 Vue dedupe，本版无需重做。

## 正式发布结果

- UI main 发布提交：`ee8fa4eb88196fa95d9c38b079c6fff215059e54`，标签 `v0.5.0`。
- [Actions 37911472623](https://github.com/LingYzh/UI/actions/runs/37911472623) 全部成功，Linux 327/327、Build、Publish 通过。
- [npm @lingyzh/ui 0.5.0](https://www.npmjs.com/package/@lingyzh/ui/v/0.5.0) 官方 metadata 已确认 version/latest=0.5.0、545 文件、正式 tarball/integrity 与 provenance。
- 正式 registry 包正常安装后的 9 项 SSR 消费检查和 UAH 工具链代表性 SFC 构建均通过。
- UAH 保持 0.4.2，尚未升级；本报告没有将临时夹具结果当作 UAH 完整验收。
