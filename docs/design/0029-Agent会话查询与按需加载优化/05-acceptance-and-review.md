# 验收标准、测试矩阵与代码审查门禁

## 判定原则

- 每个矩阵用例需同时断言响应/界面结果、状态变化及禁止的请求或副作用，不能只快照一个文本。
- 并发测试用可控制请求完成顺序的 deferred/fake XHR；不得靠 sleep 或真实网络概率复现。
- 后端查询用真实 SQLite 测试资格、排序、事务与函数；mock 数组不能证明 SQL 先过滤后分页。
- 所有旧测试应转到新契约，不为让测试通过保留生产全量兼容分支。
- 下表是最低覆盖，可拆成多条测试。运行通过与无非法调用共同构成验收，手工演示不能替代自动边界测试。

## API 与查询矩阵

| 用例标签 | 输入/安排 | 必须观察到的结果 |
|---|---|---|
| target-valid | primary/subtask 各一个有效 ID | 200 完整 11 字段；无消息/工具/模型/run-state 查询 |
| target-missing | workspace 有效，目标不存在 | 404 SESSION_NOT_FOUND；不泄漏其他归属 |
| target-cross-workspace | A 下请求 B 的 ID | 与不存在目标相同的 404；无 B 元数据 |
| workspace-missing | 单 GET、两种 scope 查询不存在 workspace | 404 WORKSPACE_NOT_FOUND；不是空成功 |
| auth | 配置 Web 鉴权，缺少/无效 cookie | 401；不依赖 internal token；关闭 Web鉴权遵循现状 |
| query-invalid | 缺 workspace/scope，未知 scope、未知参数、重复参数 | 400；没有默默退回全量 |
| tabs-no-pagination | tabs 带 limit 或 cursor，包括空值 | 400；合法 tabs 无 limit 截断 |
| page-limit | 缺省、1、50、100、0、101、小数、空值 | 合法值对应最多指定条；非法 400 |
| page-counts | 合格记录 0/1/50/51/100，limit 默认50 | 分别为0-null、1-null、50-null、50-有cursor后1-null、50-有cursor后50-null |
| page-large-limit | 100/101 个合格记录，limit100 | 100-null；或100-有cursor后1-null，SQL最多返回101条 |
| filter-before-limit | 最前100条不合格，后面有合格记录 | 首页仍返回后面的合格记录，不因提前LIMIT显示空态 |
| picker-kind-visibility | 已关闭primary、打开/未打开subtask | 合格closed primary存在；所有subtask排除 |
| head-fork-revert | head=null、Fork引用来源head、revert后head=null但历史存在 | null排除；Fork合格可入；不按历史message count判资格 |
| title-literal | 空白、trim后新会话、手动标题新会话、有内部空白标题 | 空白/新会话排除；其他保持原文本不压缩内部空白 |
| title-unicode | 空格、tab、换行、NBSP/BOM/全角空格、零宽空格 | SQL资格与JS trim完全相同；零宽空格不被额外移除 |
| ordering-ties | updatedAt相同、不同ASCII/Unicode ID | SQL按BINARY id DESC；分页边界无漏/重复，客户端不改为locale顺序 |
| static-pagination | 多页静态数据，至少3页 | 全遍历与完整资格SQL结果相同，每个ID一次 |
| cursor-valid | 服务端cursor回传，limit/workspace一致 | 正确接续，不重新从第一页 |
| cursor-invalid | 改workspace/scope/limit/v、缺字段、额外字段、类型错、负时间、超safe integer、非法UTF8/JSON/编码、>8192字符 | 400 AGENT_SESSION_CURSOR_INVALID；不执行拼接SQL，不输出cursor内容 |
| cursor-no-authority | 伪造cursor但请求scope/workspace合法 | 只能改变本请求授权workspace内位置，不取得别的workspace内容 |
| tabs-defaults | 多种kind及有效/无意义覆盖 | primary非closed＋opened subtask全返回；孤儿、跨workspace覆盖忽略 |
| tabs-all-primary | >100个默认可见primary | 全部返回，没有候选页上限误用于tabs |
| tabs-snapshot-consistency | 两个WAL连接，在snapshot首读后另一连接修改覆盖/会话 | 同一响应items/tabState来自原视图；下一请求取得新视图；不是双HTTP mock假定 |
| DB-error | 真实查询抛错/函数未注册的故障测试 | 5xx，不伪装空列表；正常所有应用/fixture连接函数已注册 |
| persistence-readonly | 对孤儿覆盖/隐藏记录发各GET | 数据行、消息、覆盖不因读取被清理 |

游标边界以源码固定测试常量。历史异常 ID/时间审计不通过时不得上线，不用静默 truncate 让测试通过。

## 首轮审查问题的必测时序

使用实际pane/context事件链、controller harness与窄wrapper，不能只在伪造纯函数状态中让测试通过。计时器受控，不用sleep。下表同时属于阶段门禁；状态/次数/释放断言缺一不可。

| 标签 | 时序与控制点 | 必须断言 |
|---|---|---|
| H1-late-timeline-after-convergence | T实际发起→manual成功→新target GET接受并清保护record→T返回 | token来自T发起；水位/epoch仍存在，title不回滚；有效正文照常更新，0额外GET/dirty |
| H1-shared-order | 新title-only接受后旧完整GET返回；再发新完整GET | 旧完整record整体拒绝，不拼新title/旧head；只新完整读产生accepted证明，title-only不产生typed full accepted证明 |
| H1-context-chain | snapshot/delta/before三种实际timeline请求、跨workspace/session、fixture缺context | 统一父级readOrder，token和record归属匹配；无有效token不发裸标题事件；正文epoch规则不改 |
| H1-no-event-on-reject | 旧readOrder或旧mutationEpoch timeline，多次返回同标题 | 拒绝不推进任何水位/epoch，不产生dirty/GET；同一有效标题重复不产生mutation事件 |
| H2-open-before-snapshot | open PUT开始→snapshot开始→PUT成功清pending→snapshot返回旧closed视图 | confirmationEpoch变，confirmed=true且成员保留；不依赖intentSeq变化 |
| H2-close-before-snapshot | close PUT开始→snapshot开始→PUT成功清pending→snapshot返回旧open视图 | confirmed=false且成员排除，旧items不能重新显示 |
| H2-failure-before-snapshot | open/close各自PUT开始→snapshot开始→最终失败清pending→snapshot返回 | 保留最近明确confirmed/default及失败回滚，不伪造成功；捕获时desired=open不能强制入成员 |
| H2-timeout-uncertain | 同上述时序但PUT15秒timeout，可能已后端提交 | uncertainCommit保留，旧snapshot不确认；之后显式新snapshot无新写时才核实；没有自动GET |
| H2-pending-at-either-end | snapshot开始/提交两端任一存在未决写 | 不安装该目标snapshot confirmed；继续原queue；成员由current effective intent决定 |
| M1-same-direction-supersede | 旧PUT在途→picker新intent未发→更晚同向intent登记 | picker订阅立即superseded一次并释放；来源不提交；不迁移，latest由自己确认 |
| M1-reverse-supersede | 同上更晚反向intent | 旧订阅同样一次superseded；原队列按最后意图补偿，无残留callback |
| M1-fast-noop | 明确confirmed=true（有效snapshot/PUT或刚创建默认），无未决不确定写，原子注册打开；再覆盖新intent | no-op同步confirmed恰一次/PUT0；提交前latest seq复核，不能用已旧confirmed关来源；有inFlight时不早确认 |
| M1-all-terminal | confirmed/failed/superseded/contextInvalidated/uiTimeout/cancelled各触发并晚到其他结果 | 每订阅结果恰好一次，timer/callback/UI订阅map释放，origin按独立生命周期清理；UI结果不送进原onMutationError(error) |
| M1-invalid-context | 已切workspace，旧context调用WithResult，同时新workspace已有有效订阅 | 立即返回contextInvalidated，无intent登记/seq增量/timer；新workspace订阅和队列不变 |
| M1-origin-release | UI终态后真实HTTP仍在途；同操作对象身份补偿、不同操作对象身份覆盖、队列终止、销毁分别触发 | UI callback/timer/resolver立即释放；只留小型去重标识，同操作补偿承接；其他终止条件清标识，无跨workspace泄漏 |
| M2-cancel-compensation-success | 原隐藏，打开PUT在途取消，补偿成功 | 来源保留，补偿确认后隐藏，非成功关闭才补偿；未知提交仍走原单飞 |
| M2-cancel-queued-open | 原目标在本次登记前effective=false，旧PUT在途，picker open已登记但未HTTP发出就取消 | 用较新恢复隐藏intent取代queued open，原UIcancel结算一次；后续不能执行取消的open，不是只取消订阅；前状态取receipt而非旧页 |
| M2-cancel-visible-or-replaced | 原可见取消；原隐藏但有更晚用户意图；补偿登记后又被新意图取代 | 原可见PUT补偿0，旧选择不撤销新意图；被取代不宣称恢复原状态，不弹旧告警 |
| M2-compensation-fails | 补偿最终500/网络/15秒timeout或30秒UI等待超时 | 不断言隐藏，不假确认；保留confirmed/default＋uncertainCommit，当前workspace提示最多一次，无无限retry；可显式关闭/核实 |
| M1-unknown-primary | 仅完整metadata GET载入未知primary，尚无有效Tab确认 | 默认可见不等于已确认，必须PUT后才关闭来源/替换草稿 |
| M2-prompt-origin | UI timeout已提示，随后同操作补偿/真实HTTP最终失败；再做独立新用户操作 | 同操作对象身份只提示一次，真实callback保持二参；独立操作有新提示资格，切workspace后旧提示0 |
| M2-switch-before-compensation | 打开PUT已发，切workspace/卸载，再取消/晚响应 | 旧上下文新增补偿0、告警0，旧PUT可后端提交；重进以真实snapshot为准，不污染新UI |
| M3-GET-slot-timeout | tabs/target/continuable各15秒不响应，随后显式retry及旧晚到 | wrapper确有timeout15000；失败token失效、槽位释放；新请求可发，旧结果/finally不提交/清新slot |
| M3-PUT-timeout-queue | PUT timeout且在途期间有较新同/反向intent | 不推断未提交，真实HTTP终态后清inFlight并补偿latest；原不确定提交规则保留 |
| M3-UI-queue-watchdog | 前一PUT排队＋自身intent，从登记起30秒UI timeout，再真实响应 | UI结算一次/释放但不清真实queue/inFlight；真实结果仍由controller处理，旧来源提交0 |
| M3-timeout-scope | 检查axios全局、metadata/PUT窄config、发送/stream/timeline | 仅窄请求15秒；共享global不变、长请求不误限；Axios timeout分类不依赖message文本 |
| M4-fresh-proof-required | 第一次target GET被保护，cache保留旧head且timeline新title；新鲜补查返回 | 旧cache不能判资格/PUT；新GET实际接受后才证明成功，最多2次实际GET，dirty与picker只合并1次补查 |
| M4-second-unaccepted | 第一次protected，第二次再次protected/superseded/失败；随后普通重复点击 | 草稿/候选/选择保留，PUT0，无第3次GET；普通点击不重置，显式retry才新代次 |
| M4-no-background-disguise | R2仍被保护、没有其他独立后台事件 | 不把R2自身拒绝标为新业务事件发R3；另外独立后台事件可另同步但不替此选择续验 |
| M4-fresh-ineligible | 补查实际接受但head=null/title新会话或不合格/kind变化 | 不PUT/替换，移除失效行，草稿保留；不用旧证明通过 |
| M4-verification-deadline | 共享GET等待＋补查过程达到选择注册后30秒 | verificationTimeout释放本UI订阅，不PUT；有其他GET消费者不清其槽位，无其他消费者按取消终止；不无限loading |
| M4-confirmation-deadline | 30秒内新鲜证明合格，再独立visibility等待30秒 | 总核实/确认最多60秒；确认timeout不删草稿，真实队列不被watchdog破坏，符合条件才有界取消补偿 |
| M4-proof-invalidated | visibility等确认时mutationEpoch或实际资格字段相对证明改变 | 不拿cache拼资格提交；来源保留、可显式retry，取消补偿按最后意图规则 |
| M4-same-title-during-confirmation | 目标GET接受→PUT等待→同标题timeline返回并推进acceptedReadOrder→PUT确认 | 完整证明仍有效，草稿替换成功；额外元数据GET0，来源/最后意图保护仍有效 |
| deadline-boundary | 在deadline之前/恰好/之后返回，clock变化和重复点击 | 单调计时不被墙钟/普通点击重置；达到deadline已失效，terminal/slot释放一次，迟到不能提交 |

## 单目标交互与元数据竞态

| 用例标签 | 安排 | 必须观察到的结果 |
|---|---|---|
| scheduled-ready | 已ready Agent，执行按钮/来源按钮点击 | 定时任务无列表/目标预校验；Agent仅一个目标GET，成功打开 |
| scheduled-gate | sessionAvailable=false但同ID实际存在 | 执行按钮仍不可导航；不能改成只按存在性可打开 |
| external-before-ready | snapshot延迟，外部打开到达 | 先等snapshot；成功后目标GET；失败不绕过初始化，重试后仍处理有效最后意图 |
| target-local-known | 目标已经缓存 | 允许乐观激活，但仍单GET核实；来源不提前关闭 |
| target-unknown | 父/子目标未加载 | 单GET upsert后打开，不全量刷新 |
| parent-success | 从子任务打开父会话 | 目标核实后才关闭来源；目标可见性PUT仍按原队列语义 |
| parent-failure | 404/网络/500/401分别模拟 | 来源不被提前关闭；404区别于可重试错误；无全量兜底 |
| source-commit-gate | 目标GET成功，打开目标PUT失败/被较新意图取代 | 不关闭来源、不替换草稿；requestVisibility返回true不代表确认；原队列无死锁 |
| intent-last-wins | A→B，B先返回，再A成功/404/500 | 最终激活B；A不关闭来源、不修改activeKey、不告警 |
| same-target-singleflight | 同目标打开与标题同步同时发生 | 同workspace该目标最多一个GET在途，各消费者按自己的token提交 |
| workspace-reuse-id | A请求未完成切B，ID恰相同 | A的record/404/finally不进入B，也不清B的新loading |
| unmount | 请求中卸载并重建组件 | 旧响应不影响新组件/持久状态 |
| target-mutation-protection | GET开始→手动标题成功→旧GET返回 | 完整保留成功record，再单目标补查；标题不回滚，updatedAt可相同 |
| stale-404-protection | GET开始→较新本地权威record/可见性成功→旧404 | 不把目标标不可用，按dirty单目标再查 |
| snapshot-vs-target | snapshot开始→较新目标GET/Fork/创建成功→snapshot迟到 | 新record保留；可见成员/意图不被snapshot缺失删除 |
| snapshot-vs-put-settled | snapshot开始→close/open PUT成功并清pending→旧snapshot | 不覆盖已确认较新意图，不能只保护当前pending |
| snapshot-vs-put-pending | snapshot提交时PUT pending/inFlight | 维持最后本地意图、PUT队列和补偿规则 |
| fork-full-record | Fork成功事件穿过helper/pane/父组件 | 完整record立即可用；无需GET列表或目标补全；过期workspace事件不写入 |
| timeline-title-only | timeline包含新title与其他head/revision | 只同步安全title；受保护标题保持；不盲目覆盖其他字段 |
| dirty-coalescing | 一次在途GET期间多次同步事件 | 当前GET结束后只有一次合并补查，无新事件则停 |
| dirty-new-event | 补查在途新增独立事件 | 允许下一轮补查；有限事件最终零请求，不由自身upsert制造事件 |
| dirty-failure-stop | 补查网络/500/401失败，idle轮询继续 | 同失败epoch不自动重发；显式重试/新独立事件才继续 |
| target-404-fallback | 当前乐观目标404，来源/其他Tab存在或都不存在 | 仅当前意图安全回退；无旧意图误创建草稿；提醒保留 |
| put-errors | PUT404/网络不确定提交、较新反向意图 | 保留0023原补偿/回滚；不推断删除、不GET兜底、不重初始化 |

## 弹窗与分页交互

| 用例标签 | 安排 | 必须观察到的结果 |
|---|---|---|
| picker-no-local-primary | visible/cache无primary，后台有closed候选或无候选 | 按草稿条件仍可打开；首屏查询，不为按钮预取历史 |
| picker-empty-error | 首屏空成功/首屏500 | 空成功显示空态；失败显示重试且不显示无候选 |
| picker-more | 多页，重复点击/滚动触发 | 只一页在途，无预取全页；最多limit候选/响应 |
| picker-more-retry | 第二页失败再重试 | 原items/cursor保留，重试同cursor，无重复行 |
| picker-end | nextCursor=null | 不再查询更多 |
| picker-duplicate | 活数据在后页重复已有ID | UI只一行，数据可更新，cursor使用服务端页结果 |
| picker-live-move | 翻页间head/title/updatedAt变化 | 不承诺快照完整；刷新首屏重新计算，不做全量补偿 |
| picker-cursor-invalid | 后续页400 cursor错误 | 保留已有列表，提示重新加载；不循环重试错误cursor |
| picker-selection | 点击同项多次/成功选择 | 无保护1次目标核实，需补查最多2次；重复点击不重置计数/时限；成功一次替换并正常关闭 |
| picker-eligibility-changed | 候选点击前revert到nullhead或改为新会话 | GET成功也拒绝继续，保留草稿，移除失效行并提示 |
| picker-target-missing | 点击候选目标404 | 不替换草稿；仅移除本行，不清全缓存/提醒 |
| picker-selection-failure | 点击后网络/401/500 | 保留草稿/候选，不标已删除；允许重试 |
| picker-close-late | 首屏/更多/选择请求中关闭 | 晚结果不写列表、不替换草稿、不激活、不告警 |
| picker-cancel-put | 原目标隐藏，目标打开PUT在途时取消选择/来源失效 | 仅最后intent且同workspace时补偿；成功才断言隐藏，失败不保证；来源保留，迟到结果不激活/替换 |
| picker-cancel-new-intent | 取消前目标又收到新的打开/关闭意图 | 不由旧选择补偿撤销较新意图；正常成功关闭弹窗不补偿 |
| picker-source-change | 切走/关闭来源、草稿开始创建或被替换/销毁 | 弹窗失效；不能作用于新草稿；旧finally不清新请求 |
| picker-refresh-race | 老页请求未结束显式刷新 | 首屏新代次唯一有效，老cursor/错误不能混入 |

## 初始化、提醒与持久数据

| 用例标签 | 安排 | 必须观察到的结果 |
|---|---|---|
| hidden-history | 大量closed primary/未打开subtask，只少量可见 | tabs records只包含可见；closed overrides仍完整；picker能找合格closed primary |
| cache-not-authoritative | 已缓存隐藏记录随后tabs缺失/picker空 | cache/settled state/持久提醒不按缺失剪枝；该隐藏缓存不意外渲染 |
| unknown-reminders | localStorage有本次未加载ID的提醒 | 初始化、关闭Tab、打开弹窗、persist后原两个时间仍保留 |
| reminder-reopen | 未加载隐藏目标经GET打开 | 恢复已有时间；markSeen按原逻辑更新，不制造重新完成声音 |
| reminder-workspace | A/B有不同已读提醒，A请求迟到 | 两个key不互相污染；不因B未加载删除A |
| reminder-404 | 真实目标404，原有提醒 | runtime停止可见轮询，持久时间保留，无后台全量清理 |
| no-history-poll | 保留大量未知提醒/候选 | 未加载隐藏会话不发run-state/model请求；候选页不成为注册全集 |
| initialization-zero | snapshot成功且零可见 | 恰一个本地草稿；不是服务器创建100个替代会话 |
| initialization-error | 关键GET500/401/协议不完整 | 专用error门控，无普通Tabs/空态/新建；重试成功才ready |
| retry-race | 尝试A失败晚于尝试B成功 | B保持ready，A不告警/回滚 |
| keepalive | 正常再激活/错误再激活 | 正常零snapshotGET；错误才新初始化；原本地意图不丢失 |
| data-upgrade | 旧库/旧localStorage复制到测试环境，启动新构建 | 会话/消息/覆盖数量及内容保持；没有Agent域重建/清空提醒 |

## 元数据网络请求预算

仅统计会话元数据列表/目标 GET 与关键 Tab 状态 GET；timeline、运行轮询、模型配置、Agent选项、Tab PUT等各自业务请求不计入，但不能借其伪装元数据全量查询。以下无网络重试、无并发新同步事件时为确定预算。

| 操作 | 阶段一 | 最终阶段二 |
|---|---|---|
| 首次初始化一次尝试 | 全量列表1＋独立Tab状态GET1 | tabs snapshot1；独立Tab状态GET0 |
| 已ready定时任务/父/子/外部目标打开 | 目标GET1，全量列表0 | 目标GET1，tabs/候选列表0 |
| 未初始化外部目标打开 | 初始化预算＋目标GET1 | tabs snapshot1＋目标GET1 |
| 同一目标并发消费者 | 真实GET最多1在途 | 同左 |
| Fork/创建/手动标题成功本身 | 元数据GET0 | 元数据GET0 |
| 一次独立自动标题完成补查 | 目标GET1，全量列表0 | 同左 |
| 在途读遇同轮本地变更需收敛 | 原GET＋一次合并目标补查；无新事件即停 | 同左；snapshot受保护目标也只单目标收敛 |
| 弹窗打开 | 不新增查询，暂用已有全量数据 | continuable首屏1，不额外tabsGET |
| 加载更多一页 | 不适用 | continuableGET1，最多limit条 |
| 选中候选 | 无保护目标GET1；最多一次新鲜补查，合计最多2 | 同左，30秒内；无第3次/额外候选/全量查询；显式retry才新预算 |
| 旧timeline在新GET清保护后返回 | 新增元数据GET0、dirty0 | 同左；不因正文可接受而补查标题 |
| 正常KeepAlive再激活 | 元数据GET0 | 同左 |
| 任意GET失败后静置且无新事件 | 自动兜底GET0 | 同左 |

后台目标同步的额外GET不超过独立dirty/有效保护收敛事件数，多个同轮事件合并；picker不论持续事件多少本次都最多2个实际请求token，耗尽后不再订阅后台第3次读。旧timeline拒绝不是dirty事件，失败同epoch请求数不得增长；新有效独立业务事件可以启动新后台同步，但不是对失败链无限retry。

### 可见性与时间预算（与元数据GET分开计数）

- 无排队、不确定性且原可见：快速no-op打开PUT0；需打开隐藏目标正常PUT1。
- 同向/反向覆盖立即结算旧UI订阅，不增加专属HTTP；真正latest队列按原规则发必要PUT，不能靠值相等省不确定提交补偿。
- 本次picker选择最多新增打开PUT1；符合条件取消最多新增恢复隐藏intent/PUT1，可能与尚未发出的打开意图合并；原本可见、已被新用户意图取代、旧workspace新增补偿0。
- 补偿失败静置新增自动retry PUT0/GET0；显式关闭是新的用户意图，显式阶段二tabs核实GET1。旧已在途PUT另计且其排队时间计入30秒等待，不能伪装为本次新增流量。
- 每实际窄GET/PUT15秒；picker核实总30秒/最多2实际GET，后续visibility等待另30秒，总最多60秒进入成功或可重试终态。之后取消补偿是独立有界等待，最多30秒UI确认，真实PUT自身15秒。
- UI watchdog/cancelled/superseded只是结算UI，新增GET0，不任意清实际PUT队列；真实HTTP终态/本地生命周期才能释放对应真实slot。
- 所有计时器和订阅终态清理有计数断言。重复普通点击、loading变化、相同idle轮询不能重置deadline或增加预算。

### 禁止调用清单

- 阶段一：定时任务组件、Fork回调、父/子/外部目标打开、自动标题同步不得调用全量 `listAgentSessions/refreshSessions`；只有初始化与其失败重试可读全量。
- 阶段二：生产代码不得发送无scope列表GET；target失败不得发tabs snapshot或continuable兜底；Agent初始化不得再调用独立Tab状态GET。
- 任一阶段：PUT失败不得启动初始化；picker不得为按钮可见性常驻预查或提前拉完所有页；不得以timeline/run-state查询替代纯元数据GET。
- 测试fixture/API集成测试统一调整契约；同路径POST创建和 `/sessions/:id/...` 操作不计入列表GET禁止项。

## 性能验证与索引门槛

固定匿名合成数据，至少覆盖：

- 1000及10000会话、约90%隐藏，少量可见且候选资格稀疏。
- 全primary默认可见，验证不截断且诚实记录初始化收益有限。
- 大量updatedAt相同的会话，检查ID次级排序及深页。
- 50/51/100页边界、同一target在N增加时返回record数量恒为1。

同环境记录响应JSON未压缩字节数、实际网络字节数（如启用压缩另列）、返回record数/覆盖ID数、请求次数、SQL EXPLAIN QUERY PLAN、预热后重复查询的中位数和P95。不要记录真实标题/正文/认证信息。报告基线与目标构建、样本数、数据分布和硬件环境，不捏造测量结果。

验收硬约束是正确查询范围和请求预算。索引评估的证据门槛：EXPLAIN出现相关临时排序/额外扫描，且代表性数据对比确认新增索引带来可重复收益、写入/存储代价可接受，并通过旧库启动/数据保留测试；未达此门槛不增加索引。若业务耗时目标需要具体毫秒阈值，测基线后由负责人确认，不在开发中凭空承诺。

## 代码审查门禁

| 审查项 | 通过条件 |
|---|---|
| scope和契约 | 判别式TypeBox与TS一致，所有消费者/fixtures改完，无兼容全量默认 |
| SQL资格 | head/trim/literal规则一致，筛选早于LIMIT，ORDER/CURSOR比较一致且参数绑定 |
| snapshot | 同一真实读事务，无await跨事务，覆盖和records规则一致 |
| target路径 | 统一所有入口、ID/workspace双校验、失败类别不混淆、无列表兜底 |
| 可见性 | default不变，来源确认门禁；snapshot前未决集合＋intentSeq＋confirmationEpoch保护，失败回滚不假确认 |
| 元数据竞态 | timeline实际发起token和共用水位，清保护不清epoch，旧标题零dirty且正文独立；不依赖DB revision/updatedAt |
| 订阅与取消 | 所有终态恰好一次，任意较新intent superseded旧等待；原HTTP callback签名不变，补偿失败不承诺隐藏 |
| 时限 | 窄15秒传输、30秒UI/核实，slot/token/callback释放，watchdog不清真实队列，无全局长请求timeout误改 |
| picker证明 | 本生命周期实际接受完整GET、最多2次，受保护cache/新title旧head不能判资格，来源保留 |
| partial集合 | 没有列表缺失剪枝/提醒丢失，不把所有cache primary显示出来 |
| picker | 独立状态机、source token、去重、选中资格复核、关闭失效、无隐藏预取 |
| 定时任务 | sessionAvailable门禁保留，来源上下文不误加执行门禁 |
| 数据与安全 | 无清库/localStorage清空，auth原路径，cursor不当权限，不输出敏感诊断 |
| 验证 | 矩阵自动测试＋阶段请求预算＋旧库启动；修改索引有可复核证据 |

任一硬约束未通过即不得验收上线，不以“自用/可停机”豁免数据保护或竞态正确性。


## 最终全面审查整改的实际回归门禁

| 标签 | 安排 | 必须断言 |
|---|---|---|
| FINAL-H1-page/target/visibility | 真实KeepAlive在首屏、目标GET、打开PUT等待中deactivate | modal关闭，来源保留；late不替换/激活/告警；正常activate不新增tabs；旧页finally不清新页loading |
| FINAL-H1-failed | 选择失败已形成retry身份后deactivate | 失败身份清理，activate不恢复旧retry、旧modal或旧代次 |
| FINAL-M1-confirmed | 原打开在途取消，补偿排队后2xx false | 一条真实PUT队列、独立补偿receipt；只有有效确认才认为隐藏，终态释放订阅 |
| FINAL-M1-failed/transportTimeout/uiTimeout | 补偿失败或15s传输/30sUI期限 | 一次含提交不确定性提示；UI期限不清真实PUT；晚失败不再提示，不无限retry |
| FINAL-M1-superseded/newIntent/workspace | 同目标较新意图、较新打开意图、workspace失效 | 旧补偿终态静默、UI资源释放；新workspace不发送旧排队补偿 |
| FINAL-M2-cache | 后台Fork入缓存但不入成员 | 不占编号，下一个可见draft使用实际下一个编号 |
| FINAL-M2-snapshot/notFound/close | 缓存被snapshot排除、有效目标404、关闭Tab | 非渲染项释放编号但缓存保留；已有可见编号稳定，尾部编号复用 |
| FINAL-M3-A-B/ABA | running后A响应在途，切B或切回A，同ID新请求在途 | 旧成功无sound/persist/transition，旧finally不释放新entry槽位 |
| FINAL-M3-dispose/replacement | dispose或同workspace entry回收重建后旧成功/失败 | 旧结果不标重试、不持久化、不发音、不清新inFlight；disposed不能重启读取 |
| FINAL-M3-current/settings | 当前后台completion与settings跨代次 | 正常完成音保留，unknown历史提醒保留；旧settings不能改当前loading/值 |
| FINAL-L1-context-end | context结束后同ID新PUT，旧PUT迟到 | sessions/writeStates/subscriptions清理；旧callback不能确认新状态或告警 |

上述用例分别进入实际ToolView组件、独立StatusStore组件（真实Axios+可控XHR）与controller测试；新组件文件必须登记固定组件runner。自动门禁和最终独立复审分别判定，不能以“测试全绿”替代复审。
