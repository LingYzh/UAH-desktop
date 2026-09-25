# 原型文案源码索引

由 `python tools/copy_inventory.py` 生成。只扫描原型源码，不扫描、删除或改写用户输入。

`prototype/remove`：删除说明或演示入口；`fixture/replace`：替换假数据及假结果；`mixed/split`：拆分文案，保留用户需要的权限、错误、操作说明。

索引按源码行定位；一行可能包含多个组件。JSON 保留完整源码，下面的摘录仅便于查找。关键词扫描是新增遗漏检查，不是自动发布清理器；未命中不等于可直接发布。

当前共 140 个源码位置。详见 COPY_GUIDE.md 的发布门槛。

| 来源 | 处置 | 摘录 |
| --- | --- | --- |
| src/app.js:19 | mixed | terminalOutput: ['PowerShell · 项目终端（交互演示）', '目录：E:\\Projects\\AgentApp', '', '输入 help 查看此原型支持的示例命令。', '此处不会执行本机命令。'], |
| src/app.js:32 | mixed | S.sessions = saved.sessions.map(session => ['running','approval'].includes(session.state) ? { ...session, state: 'stopped', kind: 'stopped', stoppedReason: '重新打开原型，之前的任务不会自动续跑。' } : session); |
| src/app.js:185 | mixed | function prototypeNote(text) { return &#96;<div class="prototype-note" data-copy-scope="prototype" data-copy-action="remove"><strong data-copy-scope="mixed" data-copy-action="split">原型说明</strong><span>${text}</span></div… |
| src/app.js:229 | mixed | <div class="sidebar-footer"><button class="user-menu" data-menu="user"><span class="avatar">DD</span><span class="user-info">本地工作区<br><span class="muted small">Used AI Harness</span></span>${icon('down')}</button><div cl… |
| src/app.js:234 | mixed | if (S.page !== 'chat') return &#96;<header class="main-header"><button class="btn ghost sm" data-action="back-chat">${icon('back')}返回对话</button><div class="header-actions" data-copy-scope="mixed" data-copy-action="split"… |
| src/app.js:261 | mixed | return &#96;<div class="home"><div class="home-scroll"><div class="home-inner"><div class="home-greeting">${mark()}<h1>今天，我们一起做点什么？</h1></div><p class="home-sub">从问题或项目出发，让想法在这里继续。</p>${S.draft.sourceSession?&#96;<div cl… |
| src/app.js:274 | mixed | if (fileId === 'large') return &#96;<div class="empty-state">${icon('file')}<h3>文件超出文本预览预算</h3><p>128 MB → 136 MB。仅显示可验证的文件元数据。<br>此原型未加载文件内容，也不伪造文本统计。</p></div>&#96;; |
| src/app.js:283 | mixed | return &#96;<div class="diff-content ${S.diffWrap ? 'wrap' : ''}"><div class="diff-hunk" data-copy-scope="mixed" data-copy-action="split">${fileId==='tool'?'@@ -21,7 +21,21 @@':fileId==='state'?'@@ -11,4 +11,10 @@':fileI… |
| src/app.js:286 | mixed | return &#96;<div class="codebox"><div class="codebox-head"><span>PowerShell · E:\\Projects\\AgentApp</span><button class="icon-btn" data-copy="${esc(command + '\n\n' + output)}" aria-label="复制命令与输出">${icon('copy')}</butt… |
| src/app.js:292 | mixed | return &#96;<div class="message-actions">${iconBtn('copy','copy-answer','复制回复')}${iconBtn('edit','edit-answer','编辑历史回复')}${iconBtn('branch','branch-session','从此回复创建分支')}${!isBusy() ? iconBtn('refresh','regenerate','重新生成最… |
| src/app.js:298 | mixed | return &#96;<div class="approval-card" id="inline-approval"><div class="approval-head">${icon('shield')}<span>${plan ? '计划已准备好，等待你的批准' : '允许执行这条命令吗？'}</span><span class="grow"></span>${pill('等待审批','warn')}</div><div clas… |
| src/app.js:305 | mixed | content += &#96;<article class="assistant-message" data-copy-scope="fixture" data-copy-action="replace">${assistantBrand()}${toolDetails('thinking','已思考 · 8 秒','我会先核对现有工具记录与历史快照的关联方式，保持权限入口不变，再调整呈现。这里仅展示供用户阅读的思考摘要。','spa… |
| src/app.js:309 | mixed | content += &#96;<article class="assistant-message" data-copy-scope="fixture" data-copy-action="replace">${assistantBrand()}<p>${isPlan ? '已经保存当前会话的实施计划，请查看计划文件后决定是否执行。' : '已完成测试范围检查，接下来需要运行已有测试，确认当前基线。'}</p>${toolDetails… |
| src/app.js:312 | mixed | content += &#96;<article class="assistant-message" data-copy-scope="fixture" data-copy-action="replace">${assistantBrand()}<p class="stream-target">${esc(t.generatedText &#124;&#124; (t.project ? '我会先核对主题变量和组件对它们的使用，再逐项验… |
| src/app.js:316 | mixed | content += &#96;<article class="assistant-message" data-copy-scope="fixture" data-copy-action="replace">${assistantBrand()}<p>已读取项目权限配置，并保存了本轮已完成的工具记录。</p>${toolDetails('saved-read','已读取权限配置','保存的只读结果仍可查看。停止不会删除已完成记录。','… |
| src/app.js:319 | mixed | content += &#96;<article class="assistant-message" data-copy-scope="fixture" data-copy-action="replace">${assistantBrand()}<h2>一次任务，从意图到可复核的结果</h2><p>UAH 将<strong>项目、对话和执行记录</strong>放在同一个工作台。开始时是草稿，首次有效发送后才建立会话。</p><bloc… |
| src/app.js:321 | mixed | if(t.editedReply) content = userHTML(t.userText&#124;&#124;'已保存的用户消息') + &#96;<article class="assistant-message" data-copy-scope="fixture" data-copy-action="replace">${assistantBrand()}<p>${esc(t.editedReply)}</p><p clas… |
| src/app.js:322 | mixed | if(t.hideReply) content = userHTML(t.userText&#124;&#124;'已保存的用户消息') + '<div class="notice" data-copy-scope="mixed" data-copy-action="split">这组回复已从原型中删除。删除记录不会撤销文件修改。</div>'; |
| src/app.js:323 | mixed | if (t.followUps) content += t.followUps.map((text,index) => userHTML(text,t.followUpAttachments?.[index] &#124;&#124; []) + &#96;<article class="assistant-message" data-copy-scope="fixture" data-copy-action="replace">${a… |
| src/app.js:326 | mixed | return &#96;${alert}<div class="chat-scroll" id="chat-scroll"><div class="transcript">${content}</div></div><div class="composer-dock"><div class="composer-dock-inner">${composerHTML()}<div class="composer-foot" data-cop… |
| src/app.js:357 | mixed | return &#96;<div class="diff-files">${S.browserTabs.map((tab,i)=>&#96;<button class="${S.browserTab===i?'active':''}" data-browser-tab="${i}">${esc(tab.name)}</button>&#96;).join('')}<button data-action="browser-new-tab"… |
| src/app.js:360 | mixed | const t=session();if(!t.manualTerminals)t.manualTerminals=[{name:'PowerShell 1',lines:['PowerShell · 手动终端（本地演示）','目录：'+(t.worktree&#124;&#124;project(t.project)?.path),'输入 help 查看示例命令。不会执行本机命令。']}]; |
| src/app.js:362 | mixed | return &#96;<div class="diff-files">${t.manualTerminals.map((term,i)=>&#96;<button class="${S.terminalTab===0&&t.activeTerminal===i?'active':''}" data-manual-terminal="${i}">${esc(term.name)} · 用户手动</button>&#96;).join('… |
| src/app.js:375 | mixed | return &#96;<div class="field"><label for="${id}">${label}</label>${type==='textarea'?&#96;<textarea id="${id}" spellcheck="false">${esc(value)}</textarea>&#96;:type==='select'?&#96;<select id="${id}">${options}</select>… |
| src/app.js:378 | mixed | return &#96;<div class="field"><label>工作目录</label><div class="directory-field"><span class="directory-field-value mono" title="${esc(d.cwd&#124;&#124;'跟随当前项目目录')}">${esc(d.cwd&#124;&#124;'跟随当前项目目录')}</span>${btn('选择文件夹',… |
| src/app.js:407 | mixed | return &#96;${pageHeader(a.id==='new'?'创建 Agent':a.name,'名称、指令和工具，在这里定义。',btn('返回 Agent','nav-agents','ghost','back'))}<div class="form-grid">${field('名称','agent-name',a.name)}${field('默认模型','agent-model',a.model,'','sel… |
| src/app.js:410 | mixed | return &#96;${pageHeader('模型与账号','一个工作台，两种接入方式。运行能力始终由真实来源决定。',S.modelTab==='api'?btn('添加供应商','provider-new','primary','plus'):btn('能力对照','runtime-capabilities','','models'))}<div class="page-tabs"><button class="${S.mod… |
| src/app.js:413 | mixed | return &#96;<div class="notice" style="margin-bottom:22px" data-copy-scope="mixed" data-copy-action="split">${icon('info')}能力列表由适配层逐项探测。未返回数据时显示“未上报”，不是 0、无额度或自动认定支持。</div><div class="table-wrap"><table><thead><tr><th>能力… |
| src/app.js:418 | mixed | return &#96;${pageHeader(p.id==='new'?'添加供应商':p.name,'配置保存在应用层，项目和会话按需选择模型。',btn('返回','nav-models','ghost','back'))}<div class="form-grid">${field('显示名称','provider-name',p.name)}${field('协议','provider-protocol',p.protoco… |
| src/app.js:422 | mixed | return &#96;${pageHeader(r.name,r.label,btn('返回账号列表','nav-subscriptions','ghost','back'))}<div class="notice" style="margin-bottom:25px" data-copy-scope="mixed" data-copy-action="split">${icon('info')}这是官方运行时连接流程的 UI 演示，… |
| src/app.js:428 | mixed | return &#96;<section data-copy-scope="prototype" data-copy-action="remove">${prototypeNote('以下为运行时适配设计与待验证假设，开发时迁入技术文档；正式界面只保留真实能力和权限状态。')}${pageHeader(runtime.name+' · 运行时适配','UAH 负责界面与会话索引，官方运行时负责执行；以下是接入规则设计和待验证边界。',b… |
| src/app.js:456 | mixed | return &#96;${pageHeader(d.id?'编辑 MCP 连接器':'添加 MCP 连接器','结构化配置启动、传输、认证和可用能力。',btn('返回连接器','nav-mcp','ghost','back'))}<div class="mcp-form-section"><div class="section-heading"><h3>基本信息</h3>${pill('全局安装')}</div><div class… |
| src/app.js:467 | mixed | ? &#96;<div class="list"><div class="list-row"><div class="grow"><h3>read_file</h3><p data-copy-scope="mixed" data-copy-action="split">已完成 · 演示事件</p></div>${btn('查看记录','mcp-call','ghost sm','chevron')}</div></div>&#96; |
| src/app.js:473 | mixed | return &#96;${pageHeader(m.name,m.desc,btn('返回连接器','nav-mcp','ghost','back'))}${m.status === 'error' ? &#96;<div class="notice error" data-copy-scope="mixed" data-copy-action="split">${icon('alert')}示例连接启动失败；没有检查你的电脑。${b… |
| src/app.js:492 | mixed | if(variants[S.editId]){const [name,source,title,text]=variants[S.editId];return &#96;${pageHeader(name,'SKILL.md · 来源：'+source,btn('返回 Skills','nav-skills','ghost','back'))}<div class="subtle-box"><span class="mono">${es… |
| src/app.js:493 | mixed | return &#96;${pageHeader('Vue 组件规范','SKILL.md · 来源：Vue 开发规范',btn('返回 Skills','nav-skills','ghost','back'))}<div class="subtle-box"><div class="between"><span class="mono small">vue-component / SKILL.md</span>${pill('只读预览… |
| src/app.js:496 | mixed | return &#96;${pageHeader('记忆','保留值得再次使用的约定，而不是重复整个对话。',btn('添加记忆','memory-new','primary','plus'))}<div class="between" style="margin-bottom:18px"><div class="searchbox" style="width:330px">${icon('search')}<input data-fi… |
| src/app.js:503 | mixed | const content = ['binary','missing','large'].includes(S.fileId)?&#96;<h1>${esc(FILES.find(f=>f.id===S.fileId)?.name)}</h1><p>当前文件的元数据预览。没有可供文本渲染的内容；此处不重建历史。</p><p>${esc(FILES.find(f=>f.id===S.fileId)?.size)}</p>&#96;:S.f… |
| src/app.js:505 | mixed | return &#96;${pageHeader('项目文件','浏览当前工作区。历史版本请从对话中的本轮改动进入。',btn('项目目录','file-open-folder','','folder'))}<div class="between" style="margin-bottom:18px"><div class="flex">${scopeSelect('files-project',S.project)}<span cla… |
| src/app.js:518 | mixed | name: 'UAH 自有引擎', status: 'Windows 命令隔离待实现', |
| src/app.js:527 | mixed | return &#96;<h2 class="settings-title">项目目录</h2><p class="muted">管理本机项目及其工作目录。会话的附加目录从输入区的主目录菜单中管理，只作用于那段会话。</p><div class="list">${S.projects.map(item=>&#96;<div class="list-row">${icon('folder')}<div class="grow"><h3>$… |
| src/app.js:533 | mixed | if(S.settingsTab==='computer') content=&#96;<h2 class="settings-title">电脑控制</h2><p class="muted">可见、可授权、可随时停止的本地操作。</p><div class="setting-row"><div><h4>允许 Windows 电脑控制</h4><p>默认关闭。开启总开关不会自动授权任意应用。</p></div>${switchButto… |
| src/app.js:534 | mixed | if(S.settingsTab==='browser') content=&#96;<h2 class="settings-title">内置浏览器</h2><p class="muted">工作与登录状态，都留在独立的浏览器配置文件里。</p><div class="setting-row"><div><h4>允许 Agent 操作内置浏览器</h4><p>默认关闭。手动浏览和模型操作分开。</p></div>${switchBut… |
| src/app.js:535 | mixed | if(S.settingsTab==='search') content=&#96;<h2 class="settings-title">网络搜索</h2><p class="muted">搜索服务独立于模型接口与浏览器登录态。</p><div class="setting-row"><div><h4>启用网络搜索</h4><p>只调用当前选择的服务，不自动回退。</p></div>${switchButton('search',S.s… |
| src/app.js:537 | mixed | if(S.settingsTab==='data') content=&#96;<h2 class="settings-title">数据与迁移</h2><p class="muted">明确导入、明确导出。不做跨设备实时同步。</p><div class="setting-row"><div><h4>从 Android / UAH 导入</h4><p>先验证、预览冲突，再选择更新、副本或跳过。</p></div>${btn('导入数据… |
| src/app.js:538 | mixed | if(S.settingsTab==='diagnostics') content=&#96;<h2 class="settings-title">诊断与关于</h2><div class="about-brand">${mark()}<div><h3>Used AI Harness</h3><p class="muted small" data-copy-scope="mixed" data-copy-action="split">P… |
| src/app.js:554 | mixed | $('#app').innerHTML=&#96;<div class="titlebar"><div class="titlebar-brand">${mark()}<span>Used AI Harness</span></div><div class="titlebar-center">${S.page==='chat'?esc(project(session().project)?.name&#124;&#124;'无目录会话'… |
| src/app.js:565 | mixed | const root=$('#toast-root');root.innerHTML=&#96;<div class="toast" data-copy-scope="${copyScope}" data-copy-action="${copyScope==='product'?'keep':'split'}">${icon(type==='error'?'alert':type==='success'?'check':'info')}… |
| src/app.js:601 | mixed | wide=true;html=&#96;<div class="searchbox">${icon('search')}<input id="model-search" placeholder="搜索模型、供应商或运行时" aria-label="搜索模型"></div><div class="pop-label">自配 API · UAH 自有引擎</div>${MODELS.filter(m=>m.source==='api').m… |
| src/app.js:615 | mixed | if(name==='project')html=&#96;<div class="pop-label">${esc(project(S.projectMenu)?.name)}</div>${menuItem('在此项目新建对话','data-action="project-chat"','edit')}${menuItem('重命名项目','data-action="rename-project"','edit')}${menuIt… |
| src/app.js:616 | mixed | if(name==='user')html=&#96;<div class="pop-title">本地工作区</div><div class="notice">无 UAH 云端账号；订阅运行时账号分别管理。</div>${menuItem('设置','data-nav="settings"','settings')}${menuItem('数据导入 / 导出','data-action="settings-data"','databa… |
| src/app.js:649 | mixed | modal(p.git?'这个目录中已有活动会话':'这个目录正在被其他会话使用',&#96;<p>${esc(p.name)} 中有 ${active.length} 个正在执行或等待审批的会话。选择新会话如何使用目录。</p><div class="subtle-box"><div class="flex">${statusDot(active[0]?.state&#124;&#124;'running')}<span>${esc(… |
| src/app.js:698 | mixed | modal('上下文',&#96;<div class="between"><h3 style="margin:0">${known?&#96;${(used/1000).toFixed(1)}K / 200K&#96;:'容量未上报'}</h3>${pill(known?'本地估算 · 示例':'不可计算使用率')}</div><p class="small muted" style="margin:10px 0" data-copy… |
| src/app.js:726 | mixed | render(true);prototypeToast('已选择 MCP 工作目录；网页原型只取得文件夹名称。');return; |
| src/app.js:735 | mixed | prototypeToast('已选择文件夹；网页原型只取得名称，正式客户端会保存完整 Windows 路径。'); |
| src/app.js:758 | mixed | if(!preview){modal('导入数据',&#96;<p>从 Android / UAH 导入配置与会话。先校验再预览，不立即写入。</p><div class="drop-zone">${icon('download')}<h3>选择一个导出文件</h3><p class="small muted">原型支持读取自身导出的 JSON，或使用内置冲突样本。<br>ZIP 解包流程只演示，不执行真实归档恢复。</p>${btn(… |
| src/app.js:760 | mixed | modal('预览导入与冲突',&#96;<div class="stepper"><span>1 选择文件</span><span class="active">2 校验与冲突</span><span>3 确认导入</span></div><p data-copy-scope="mixed" data-copy-action="split">已读取 ${rows.length} 项${S.importRows?'原型 JSON':'演… |
| src/app.js:763 | mixed | modal('导出配置与会话',&#96;<p data-copy-scope="mixed" data-copy-action="split">选择要带走的数据。此原型生成 JSON，不包含真实文件、密钥或登录信息。</p><div class="permissions-grid">${[['providers','模型配置'],['agents','Agent'],['memories','记忆'],['sessions','会话记… |
| src/app.js:767 | mixed | modal(update?'预览插件更新':'预览插件安装',&#96;<div class="stepper"><span class="active">1 检查清单</span><span>2 项目启用</span><span>3 独立授权</span></div><div class="between"><h3>${update?'Vue 开发规范 1.1.0':'代码质量工具箱'}</h3>${pill('本地包 · 示例')}… |
| src/app.js:770 | mixed | modal('允许这个 hook 执行吗？',&#96;<p>来自 <strong>${esc(p.name)}</strong> 的 <strong>after-file-edit</strong> 将在编辑后执行。插件安装与启用本身没有授予这项权限。</p><div class="codebox"><div class="codebox-head">执行内容</div><pre>node ./hooks/format-check.m… |
| src/app.js:774 | mixed | modal(&#96;${r.name} · 官方登录&#96;,S.loginStage===0?&#96;<p>UAH 只启动未修改的官方客户端认证流程，不接收账号密码、不复制令牌。</p><div class="subtle-box"><div class="flex">${icon('external')}<span>在官方客户端完成登录</span></div><p class="small muted" style="mar… |
| src/app.js:779 | mixed | if(!enabled){confirmDialog('控制总开关尚未打开',&#96;${kind==='browser'?'内置浏览器':'Windows 电脑'}控制默认关闭。开启后仍然需要会话模式和目标授权；本原型不操作真实设备。&#96;,kind==='browser'?'enable-browser':'enable-computer','开启演示总开关');return;} |
| src/app.js:787 | mixed | modal(authorized?'批准这一次操作？':'允许操作这个目标吗？',&#96;<div class="subtle-box"><div class="flex">${icon(kind==='browser'?'globe':'monitor')}<strong>${kind==='browser'?esc(browserTarget()):'记事本 · Windows 11'}</strong></div><p clas… |
| src/app.js:794 | mixed | S.browserLogs.unshift(&#96;${write?'已执行示例动作':'已读取示例观察'} · ${kind==='browser'?browserTarget():'记事本'} · snapshot-${S.observation}&#96;); |
| src/app.js:795 | mixed | closeModal();render(true);toast(write?'演示动作已完成，未操作你的电脑。':'已获得新的示例观察快照。','success'); |
| src/app.js:798 | mixed | const result={format:'uah-pc-ui-prototype',version:1,createdAt:new Date().toISOString(),notice:'仅为交互原型数据，不是正式 UAH 备份。无真实凭据或本机文件。',data:{}}; |
| src/app.js:805 | mixed | if(sensitive)result.sensitiveExport='用户确认敏感导出的 UI 流程；此原型没有保存或导出任何真实密钥。'; |
| src/app.js:806 | mixed | downloadJSON(result,'UAH_Prototype_Export.json');closeModal();prototypeToast('已生成原型 JSON。密钥、请求头与执行授权未导出。','success'); |
| src/app.js:822 | mixed | closeModal();render();modal('导入已完成',&#96;<div class="empty-state" style="padding:20px 0">${icon('check')}<h3 data-copy-scope="mixed" data-copy-action="split">已处理 ${count} 项原型数据</h3><p>被跳过的项目保持不变，所有导入任务处于中止状态。<br>设备授权、hoo… |
| src/app.js:825 | mixed | modal('搜索',&#96;<div class="searchbox">${icon('search')}<input id="global-search" value="${esc(query)}" placeholder="搜索会话、项目与设置" aria-label="搜索会话、项目与设置"></div><div id="search-results" style="margin-top:15px">${searchResu… |
| src/app.js:835 | mixed | if(action.startsWith('copy-round-')){copyText('已完成工具展开交互设计。所有记录均为本地演示。');return;} |
| src/app.js:838 | mixed | if(action.startsWith('edit-round-')){modal('编辑已保存回复',&#96;${field('正文','edit-message-text','已完成轻量工具行与历史 Diff 的示例设计。','编辑历史不会自动调用模型或重新运行工具。','textarea')}&#96;,&#96;${btn('取消','close-modal')}${btn('仅保存历史修改','save-message',… |
| src/app.js:839 | mixed | if(action.startsWith('delete-round-')){confirmDialog('删除这组回复记录？','删除正文与其工具展示记录，不会撤销本地文件改动。此原型仅隐藏样例正文。','delete-message-confirm','删除记录',true);return;} |
| src/app.js:859 | mixed | case 'resume':session().state='running';session().kind='running';sessionWorkspace().backgroundTasks.push({id:'resume-'+Date.now(),title:'手动继续任务',state:'running',detail:'本地模拟任务正在运行',time:'刚刚'});render(true);prototypeToast… |
| src/app.js:860 | mixed | case 'approve-command':session().state='running';session().kind='running';session().generatedText='本次命令已获明确批准。正在模拟运行测试，记录将保留在这一轮。';render(true);prototypeToast('仅批准了这一次示例命令。');break; |
| src/app.js:869 | mixed | case 'open-folder':case 'file-open-folder':prototypeToast('正式桌面版将在系统文件管理器打开目录；原型不会访问本机文件。');break; |
| src/app.js:870 | mixed | case 'current-file':S.fileId=S.diffFile;S.project=session().project;navigate('files');prototypeToast('已切换到当前文件示例，不是历史快照。');break; |
| src/app.js:874 | mixed | case 'branch-details':{const p=project(config().project),label=p?.git?(config().worktree?'独立 Git worktree':p.branch&#124;&#124;'当前分支未上报'):'没有仓库';modal('目录与仓库',&#96;<div class="list"><div class="setting-row"><div><h4>工作目录… |
| src/app.js:877 | mixed | case 'compact-confirm':confirmDialog('压缩后续上下文？','将生成用于下一轮的摘要，原始历史和工具结果保留。此原型用固定样本演示完成状态，不执行模型压缩。','compact-do','确认压缩');break; |
| src/app.js:893 | mixed | case 'delete-session':confirmDialog('删除会话？','删除这份原型中的会话记录。活动任务会先中止，删除不会撤销本机文件改动。','delete-session-confirm','删除会话',true);break; |
| src/app.js:895 | mixed | case 'export-session':downloadJSON({format:'uah-pc-prototype-session',notice:'演示数据',session:session()},'UAH_Session_Demo.json');closeMenu();break; |
| src/app.js:904 | mixed | case 'remove-project':confirmDialog('从工作区移除项目？','仅移除原型中的项目与会话记录，不会删除真实目录。活动任务会先中止。','remove-project-confirm','移除项目',true);break; |
| src/app.js:908 | mixed | case 'attach-project':if(!config().project){closeMenu();toast('当前没有绑定目录。可以先引用本地会话或上传文件。');break;}closeMenu();modal('添加项目文件',&#96;<p data-copy-scope="mixed" data-copy-action="split">选择用于演示的项目文件。附件只绑定当前消息，不复制到下一个新对话。</p>${… |
| src/app.js:913 | mixed | case 'save-agent':{if(!$$('input[name="agent-tool"]:checked').length){toast('请至少选择一种工具；当前版本不支持保存全部禁用的 Agent。','error');return;}const name=$('#agent-name').value.trim();if(!name){toast('Agent 名称不能为空。','error');return;}con… |
| src/app.js:918 | mixed | case 'test-provider':case 'mcp-test':case 'test-search':{const old=el?.innerHTML;if(el){el.disabled=true;el.innerHTML=&#96;${icon('refresh')}测试中…&#96;;}setTimeout(()=>{if(el?.isConnected){el.disabled=false;el.innerHTML=o… |
| src/app.js:919 | mixed | case 'fetch-models':modal('模型目录 · 示例返回',&#96;<p data-copy-scope="mixed" data-copy-action="split">这里演示“接口获取 / 手动添加”的工作流。并未向供应商接口发起请求。</p><div class="list">${MODELS.filter(x=>x.source==='api').map(m=>&#96;<div class="list-… |
| src/app.js:925 | mixed | case 'delete-provider':confirmDialog('删除供应商？','只删除原型中的非敏感配置，相关历史记录保留。','delete-provider-confirm','删除供应商',true);break; |
| src/app.js:928 | mixed | case 'runtime-detect':{const r=S.runtimes.find(x=>x.id===S.editId);if(!r.installed){modal('官方客户端安装',&#96;<p data-copy-scope="mixed" data-copy-action="split">正式桌面版会提供官方安装说明及安装状态检测，不修改官方客户端。原型仅演示未安装 → 已检测状态。</p><div class=… |
| src/app.js:931 | mixed | case 'login-complete':{const r=S.runtimes.find(x=>x.id===S.editId);r.logged=true;r.account='demo@example.com';r.model='由官方运行时返回的模型 · 示例';S.loginStage=1;loginModal();break;} |
| src/app.js:933 | mixed | case 'runtime-logout':confirmDialog('退出当前官方账号？','正式应用将调用官方退出流程，不私自复制或删除令牌。本原型只清空示例连接状态。','runtime-logout-confirm','退出账号');break; |
| src/app.js:935 | mixed | case 'runtime-models':{const r=S.runtimes.find(x=>x.id===S.editId);if(!r.logged){prototypeToast('请先完成官方登录的演示流程。');break;}modal('运行时模型返回',&#96;<div class="subtle-box">${esc(r.model)}</div><div class="notice" style="margin… |
| src/app.js:954 | mixed | const item={id:d.id&#124;&#124;'mcp-'+Date.now(),name:d.name,transport:d.transport,command:d.transport==='stdio'?&#96;${d.executable} ${d.args.split('\n').filter(Boolean).join(' ')}&#96;.trim():d.url,executable:d.executa… |
| src/app.js:956 | mixed | S.mcpDraft=null;navigate('mcp-detail',item.id);prototypeToast('已保存配置。凭据值没有写入原型存档；连接仍需单独测试。');break; |
| src/app.js:958 | mixed | case 'mcp-auth':modal('服务器登录授权',&#96;<p data-copy-scope="mixed" data-copy-action="split">正式应用将遵循服务器要求完成认证；原型只模拟授权结果。</p><div class="notice">${icon('lock')}只为这个 MCP 服务器建立认证，不共享模型密钥或内置浏览器登录态。</div>&#96;,&#96;${btn('取消','cl… |
| src/app.js:960 | mixed | case 'mcp-retry':{const m=S.mcps.find(x=>x.id===S.editId);m.status='connected';m.desc='模拟重试连接成功';m.tools=8;render(true);prototypeToast('示例重试成功，未启动真实进程。');break;} |
| src/app.js:962 | mixed | case 'mcp-remove':confirmDialog('移除连接器？','从原型的全局配置中移除，并清除项目启用关系。','mcp-remove-confirm','移除',true);break; |
| src/app.js:964 | mixed | case 'mcp-call':modal('read_file · 调用记录',commandBody('read_file({ path: "AGENTS.md" })','读取成功 · 只读示例结果 · 未访问真实文件。'),btn('关闭','close-modal'));break; |
| src/app.js:965 | mixed | case 'mcp-resource':modal('project://readme',&#96;<article class="prose"><h2>Used AI Harness</h2><p data-copy-scope="mixed" data-copy-action="split">示例 MCP 只读资源。以实际服务器返回的资源内容和类型为准。</p></article>&#96;,btn('关闭','close-moda… |
| src/app.js:970 | mixed | case 'plugin-install':{const enabled=$('#enable-imported-plugin')?.checked;if(S.pluginUpdate){const p=S.plugins.find(x=>x.id===S.editId)&#124;&#124;S.plugins[0];p.previousVersion=p.version;p.version='1.1.0';p.hookEnabled… |
| src/app.js:971 | mixed | case 'allow-hook':{const p=S.plugins.find(x=>x.id===S.pendingHook);p.hookEnabled=true;closeModal();render(true);prototypeToast('已单独授权此示例 hook，不会执行真实脚本。');break;} |
| src/app.js:972 | mixed | case 'plugin-manifest':modal('插件原始清单',&#96;<div class="codebox"><pre>${esc(JSON.stringify({name:'vue-best-practices',version:'1.0.0',skills:['vue-component','vue-theme'],agents:['reviewer'],rules:['AGENTS.md'],hooks:{'af… |
| src/app.js:974 | mixed | case 'plugin-uninstall-confirm':S.lastUninstalled=clone(S.plugins.find(x=>x.id===S.editId));S.plugins=S.plugins.filter(x=>x.id!==S.editId);navigate('plugins');prototypeToast('插件已从原型卸载，源包与恢复记录保留。');break; |
| src/app.js:976 | mixed | case 'plugin-restore':{const p=S.plugins.find(x=>x.id===S.editId);if(p?.previousVersion){p.version=p.previousVersion;delete p.previousVersion;p.hookEnabled=false;render(true);toast('已恢复旧版，hooks 需重新授权。');}else prototypeTo… |
| src/app.js:994 | mixed | case 'enable-computer':S.switches.computer=true;closeModal();render(true);prototypeToast('已打开演示开关，尚未授予目标应用权限。');break; |
| src/app.js:995 | mixed | case 'enable-browser':S.switches.browser=true;closeModal();render(true);prototypeToast('已打开演示开关，尚未授权网站操作。');break; |
| src/app.js:999 | mixed | case 'refresh-observation':S.targetChanged=false;S.observation++;closeModal();render(true);prototypeToast('已获取新的示例观察；请重新请求动作。');break; |
| src/app.js:1004 | mixed | case 'clear-browser':S.browserLogged=false;S.browserAllowed=false;S.lease=null;render(true);prototypeToast('已清除示例浏览器状态，系统浏览器不受影响。');break; |
| src/app.js:1005 | mixed | case 'browser-login':modal('手动网站登录',&#96;<p>网站登录由用户在内置浏览器完成。Agent 不接触密码，浏览器登录态不共享给模型接口。</p><div class="subtle-box" data-copy-scope="mixed" data-copy-action="split">localhost:5173 · 演示网站</div><p class="small muted" style=… |
| src/app.js:1006 | mixed | case 'browser-login-complete':S.browserLogged=true;closeModal();render(true);prototypeToast('示例网站已登录。Agent 操作权限仍需单独授权。');break; |
| src/app.js:1010 | mixed | case 'browser-refresh':S.targetChanged=true;render(true);prototypeToast('示例页面已刷新，旧观察快照失效。');break; |
| src/app.js:1011 | mixed | case 'terminal-new':{const t=session();t.manualTerminals=t.manualTerminals&#124;&#124;[];t.manualTerminals.push({name:'PowerShell '+(t.manualTerminals.length+1),lines:['新建的独立手动终端（演示）','目录：'+(t.worktree&#124;&#124;project… |
| src/app.js:1018 | mixed | case 'undo-import':if(S.importBackup){Object.assign(S,S.importBackup);S.importBackup=null;closeModal();render();prototypeToast('已恢复导入前的原型数据。');}break; |
| src/app.js:1020 | mixed | case 'perform-export':{const sections=$$('input[name="export-section"]:checked').map(x=>x.value);if(!sections.length){toast('请至少选择一类数据。','error');return;}S.exportSections=sections;if($('#export-sensitive').checked){confi… |
| src/app.js:1022 | mixed | case 'reset-prototype':confirmDialog('重置原型数据？','清除浏览器为这份原型保存的演示配置，恢复初始样本。不会影响你的 GitHub 或电脑文件。','reset-confirm','重置原型',true);break; |
| src/app.js:1026 | mixed | case 'exit-app':modal('退出 Used AI Harness？',&#96;<p>当前有 <strong>${activeCount()} 个</strong>活动任务。退出会中止由 UAH 管理的任务，保存中止原因与已完成记录，下次启动不自动续跑。</p><div class="list">${S.sessions.filter(isBusy).map(t=>&#96;<div class="list-row">… |
| src/app.js:1029 | mixed | case 'window-min':prototypeToast('窗口控制仅作样式演示；不会最小化浏览器。');break; |
| src/app.js:1032 | mixed | default:prototypeToast('此入口为原型展示项，未连接外部服务。');console.info('Unimplemented prototype action:',action); |
| src/app.js:1138 | mixed | function runDemoTerminal(value){const command=value.trim();if(!command)return;S.terminalOutput.push('PS> '+command);const outputs={help:'支持的演示命令：help、pwd、dir、git status、npm test、clear。其他输入不会执行。',pwd:session().worktree&#1… |
| src/app.js:1139 | mixed | $('#attachment-input').addEventListener('change',event=>{const c=config();c.attachments=c.attachments&#124;&#124;[];for(const file of event.target.files)c.attachments.push({name:file.name,size:file.size,type:file.type,so… |
| src/app.js:1160 | mixed | if(file.size>2*1024*1024){prototypeToast('原型只接受小于 2 MB 的 JSON 演示数据。','error');return;} |
| src/app.js:1161 | mixed | if(!file.name.toLowerCase().endsWith('.json')){prototypeToast('ZIP 恢复只提供流程演示，请使用内置冲突样本。');return;} |
| src/app.js:1162 | mixed | try{const raw=JSON.parse(await file.text());if(raw.format!=='uah-pc-ui-prototype'&#124;&#124;!raw.data&#124;&#124;typeof raw.data!=='object')throw new Error('不是这份原型的 JSON 导出格式'); |
| src/app.js:1173 | mixed | const sample=task.project?'我会先读取项目说明，明确这次任务的范围，再拆成可检查的步骤。工具调用采用轻量展开行，保存的历史 Diff 与当前文件分开。每个需要写入或外部操作的步骤，都遵循当前会话权限。这是本地模拟的流式回复，没有调用模型或执行工具。':'我会先理解你的问题，再给出可检查的步骤。当前会话没有绑定目录，可以正常对话；如需访问项目文件或运行命令，可稍后在输入框上方选择目录。这是本地模拟的流式回复，没有… |
| src/app.js:1251 | mixed | function guideModal(){modal('原型导览',&#96;<p data-copy-scope="mixed" data-copy-action="split">全部 ${SCENES.length} 个场景均可从实际界面进入，也可在这里跳转。跳转恢复固定样本，不修改你的真实项目。</p><div class="flex small muted" style="margin-bottom:18px;flex-wra… |
| src/data.js:5 | fixture | const PROJECTS = [ |
| src/data.js:10 | fixture | const MODELS = [ |
| src/data.js:11 | mixed | { id: 'sonnet-api', name: 'Sonnet 4.6', wire: 'claude-sonnet-4-6', source: 'api', runtime: 'UAH 自有引擎', provider: 'Anthropic API', efforts: ['low','medium','high','max'], media: '文本 · 图像 · PDF', context: '200K（示例）' }, |
| src/data.js:19 | fixture | const AGENTS = [ |
| src/data.js:25 | fixture | const SESSIONS = [ |
| src/data.js:33 | fixture | const SESSION_WORKSPACE = { |
| src/data.js:80 | fixture | const FILES = [ |
| src/data.js:91 | fixture | const DIFF_LINES = [ |
| src/data.js:116 | fixture | const PROVIDERS = [ |
| src/data.js:122 | fixture | const RUNTIMES = [ |
| src/data.js:129 | fixture | const RUNTIME_ADAPTERS = { |
| src/data.js:154 | mixed | auto: ['需核对', '明确的 permissions.allow 规则', '不使用 --dangerously-skip-permissions 来模拟 UAH 自动模式'], |
| src/data.js:167 | fixture | const MCPS = [ |
| src/data.js:173 | fixture | const PLUGINS = [ |
| src/data.js:178 | fixture | const MEMORIES = [ |
| src/index.template.html:7 | mixed | <meta name="description" content="Used AI Harness PC UI 交互原型。根据 AgentApp 功能设计制作，所有运行时与工具操作均为本地演示。"> |
