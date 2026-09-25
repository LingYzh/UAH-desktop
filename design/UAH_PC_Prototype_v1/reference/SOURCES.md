# 设计来源与读取基线

读取日期：2026-09-25（Asia/Tokyo）。来源用于功能和公开设计参考；运行时功能样本不是额外的官方兼容性承诺。

## 用户仓库：功能权威

仓库：`LingYzh/AgentApp`；读取分支：`master`；提交：`a149f2ef6f0a955cfd5f289601c5e122e533ab56`。

- 功能设计全文：`design/UAH_PC_HARNESS_FUNCTIONAL_DESIGN.md`。Blob `8e4896d2ce45552cdd8227c9ffd0cc0b16c651ba`。
  https://github.com/LingYzh/AgentApp/blob/a149f2ef6f0a955cfd5f289601c5e122e533ab56/design/UAH_PC_HARNESS_FUNCTIONAL_DESIGN.md
- 项目约定：`AGENTS.md`，优先注意草稿、历史快照、工具范围、权限和品牌的已核实约定。
  https://github.com/LingYzh/AgentApp/blob/a149f2ef6f0a955cfd5f289601c5e122e533ab56/AGENTS.md
- Android 旧视觉规格：`design/agentapp-ui-v3/AgentApp_UI_Prototype_v3/DESIGN_SPEC.md`。参考工具行、颜色、输入和阅读方式；其旧功能边界不能覆盖 PC 新文档。
  https://github.com/LingYzh/AgentApp/blob/a149f2ef6f0a955cfd5f289601c5e122e533ab56/design/agentapp-ui-v3/AgentApp_UI_Prototype_v3/DESIGN_SPEC.md
- UAH 标志：`design/UAH_Android_Icon_Kit_v1/android/app/src/main/res/drawable/ic_uah_mark.xml`，Blob `132b337eec58d65bbec490741be832f39c2706e2`。保留原路径几何并转写为 SVG，未重新设计标志。
  https://github.com/LingYzh/AgentApp/blob/a149f2ef6f0a955cfd5f289601c5e122e533ab56/design/UAH_Android_Icon_Kit_v1/android/app/src/main/res/drawable/ic_uah_mark.xml

## Claude 官方公开设计参考

1. Anthropic，2026-04-14，Redesigning Claude Code on desktop for parallel agents。
   https://claude.com/blog/claude-code-desktop-redesign
   对应参考：并行会话侧栏、项目分组、终端 / 文件 / Diff / 预览工作区、灵活面板和用量入口。UAH 保持自己的功能范围，不照搬 Claude 的服务限制或品牌。
2. Claude Help Center，Customizing your appearance settings。
   https://support.claude.com/en/articles/8887527-customizing-your-appearance-settings
   对应参考：light / dark / system 主题、字体偏好与侧栏收放。
3. Claude Help Center，What are artifacts and how do I use them?
   https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them
   对应参考：正文旁独立查看内容的关系；UAH 的 Diff、计划与产物沿用这种并排阅读逻辑。

## 参考的边界

公开资料用于确认界面语言和信息组织。未登录用户的 Claude 账号，未认证某个客户端版本或灰度发布批次的逐像素一致性。颜色来自用户项目已经确定的暖白 / 暖灰 / 陶土 Token，标题和界面用系统字体回退；不分发 Claude 品牌字体、网页源码或官方截图资源。

原型所有截图均从本交付 `index.html` 实际渲染生成。图中的账号、目录、文件差异、运行时间、额度状态和命令输出均为设计样本，不是对真实服务或用户本地文件的运行报告。
