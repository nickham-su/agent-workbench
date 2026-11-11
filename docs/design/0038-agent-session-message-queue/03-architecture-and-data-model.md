> 当前增量（15e2590之后）：Web Stop改为事务内清当前队列，发送统一启动；固定目标clear与持久Stop代际无需数据库迁移。旧版通过结论仅覆盖基线，详见本文末“Esc增量事务”。

# 架构、实体、恢复与预算

## 权威边界

- API通过SQLite事务管理收件、正式消息链、暂停及幂等；Worker通过受保护RPC请求操作，不直连SQLite。
- 入队不修改消息head；注入复用现有head/revision CAS和active Run fence。单Session单有效Run不变。
- 新增“输入确认”与“放弃”表达是否允许压缩／恢复，不把injected倒退为queued。
- 本文的实体、完整输入估算和发布留存账本均为本次新增；现有能力只是部分原语，不得声称已经有精确token预算或安全Workspace附件GC。

## 实体与键

以下为实施必须满足的DDL约束。时间为服务端毫秒，序号／版本为非负安全整数，溢出拒绝。所有表随schema版本迁移；未列字段不得隐含承担状态。H5四表纳入分类器／签名及非破坏迁移；不得借Agent域rebuild丢弃停止屏障、固定目标或Run绑定。

### 父键与作用域

新增唯一索引作为复合FK父键，不能仅凭两个单列FK声称能防scope mismatch：

```sql
create unique index uq_agent_session_scope on agent_session(workspace_id, id);
create unique index uq_agent_attachment_scope on agent_attachment(workspace_id, id);
create unique index uq_agent_run_scope on agent_run(workspace_id, session_id, run_id);
create unique index uq_agent_message_origin_scope
  on agent_message(workspace_id, origin_session_id, id);
```

- Session／Run／Message现有主键与既有FK保持。message的origin_session_id可能NULL；仅本次生成且origin_session_id非NULL的user／assistant使用该复合父键。
- 后续删除必须先清新表再改变现有origin引用，不能让ON DELETE SET NULL意外撞上新增作用域FK。

### `agent_session_queue_control`

```sql
create table agent_session_queue_control (
  workspace_id text not null,
  session_id text primary key,
  mode text not null check(mode in ('active','paused')),
  pause_code text,
  queue_version integer not null check(queue_version >= 0),
  next_sequence integer not null check(next_sequence >= 1),
  updated_at integer not null,
  unique(workspace_id, session_id),
  foreign key(workspace_id, session_id)
    references agent_session(workspace_id, id) on delete cascade,
  check((mode='active' and pause_code is null) or
        (mode='paused' and pause_code is not null))
);
```

控制行懒创建；INSERT冲突后读取同一行。COUNT/SUM通过queued索引计算，不存冗余数量。

### `agent_user_message_receipt`

核心字段和约束：

```sql
create table agent_user_message_receipt (
  id text primary key,
  workspace_id text not null,
  session_id text not null,
  client_request_id text not null,
  sequence integer not null check(sequence >= 1),
  payload_hash text not null,
  status text not null check(status in ('queued','injected','cancelled')),
  input_text text,
  text text,
  payload_bytes integer not null check(payload_bytes >= 0),
  attachment_count integer not null check(attachment_count between 0 and 4),
  agent_id text not null,
  provider_id text not null,
  model_id text not null,
  ui_locale text,
  message_id text unique,
  injected_run_id text,
  confirmation_state text check(confirmation_state in ('unconfirmed','confirmed','abandoned')),
  confirmed_at integer,
  confirmation_source text check(confirmation_source in ('worker_model','local_fallback')),
  confirmed_by_assistant_id text,
  abandoned_at integer,
  created_at integer not null,
  updated_at integer not null,
  unique(workspace_id, session_id, id),
  unique(workspace_id, session_id, client_request_id),
  unique(session_id, sequence),
  foreign key(workspace_id, session_id)
    references agent_session_queue_control(workspace_id, session_id) on delete cascade,
  foreign key(workspace_id, session_id, message_id)
    references agent_message(workspace_id, origin_session_id, id) on delete restrict,
  foreign key(workspace_id, session_id, injected_run_id)
    references agent_run(workspace_id, session_id, run_id) on delete restrict,
  foreign key(workspace_id, session_id, confirmed_by_assistant_id)
    references agent_message(workspace_id, origin_session_id, id) on delete restrict,
  check((status='queued' and text is not null and input_text is not null
          and message_id is null and injected_run_id is null and confirmation_state is null)
     or (status='cancelled' and message_id is null and injected_run_id is null and confirmation_state is null)
     or (status='injected' and message_id is not null and injected_run_id is not null
          and confirmation_state is not null)),
  check(coalesce((confirmation_state='confirmed' and confirmed_at is not null
          and confirmation_source is not null and confirmed_by_assistant_id is not null
          and abandoned_at is null)
     or (confirmation_state='abandoned' and abandoned_at is not null
          and confirmed_at is null and confirmation_source is null and confirmed_by_assistant_id is null)
     or (confirmation_state='unconfirmed' and confirmed_at is null
          and confirmation_source is null and confirmed_by_assistant_id is null and abandoned_at is null)
     or (confirmation_state is null and confirmed_at is null
          and confirmation_source is null and confirmed_by_assistant_id is null and abandoned_at is null), 0))
);
create index idx_agent_receipt_queued
  on agent_user_message_receipt(session_id, sequence) where status='queued';
create index idx_agent_receipt_unconfirmed
  on agent_user_message_receipt(session_id, sequence)
  where status='injected' and confirmation_state='unconfirmed';
```

- 状态边：queued→injected／cancelled；injected的confirmation_state仅unconfirmed→confirmed或abandoned。终态不可逆。
- `injected_run_id`保存最初注入Run；续接不能改写它。新消息ID独立生成，不再统一按Run ID派生。
- confirmed不等于用户目标完成：Worker是实际合法模型结果完成；fallback是本地回显完成，来源必须区分。
- 新Web收件以receipt为去重权威，不为每条收件伪造旧agent_client_request映射；旧记录仅服务既有强制触发，新旧入口均检查另一命名空间冲突。
- receipt保留hash及终态墓碑至Session真实删除；清理重复正文不能删掉幂等身份。abandoned正文保留在正式历史，UI标明“未处理，已放弃”。

### 附件关联

```sql
create table agent_user_message_receipt_attachment (
  workspace_id text not null,
  session_id text not null,
  receipt_id text not null,
  position integer not null check(position between 0 and 3),
  attachment_id text not null,
  byte_sha256 text not null,
  primary key(receipt_id, position),
  unique(receipt_id, attachment_id),
  foreign key(workspace_id, session_id, receipt_id)
    references agent_user_message_receipt(workspace_id, session_id, id) on delete cascade,
  foreign key(workspace_id, attachment_id)
    references agent_attachment(workspace_id, id) on delete restrict
);
```

queued附件只关联receipt；注入时创建正式image parts。取消／放弃不触发Workspace文件unlink，见发布留存账本。

### `agent_queue_operation`

- 字段：workspace_id、session_id、operation_id、kind、request_hash、result_json、created_at。
- PK `(workspace_id,session_id,operation_id)`；复合FK control同scope ON DELETE CASCADE。
- kind枚举stop/resume/abandon/prepare/inject/complete_or_continue；Worker操作result含稳定Run／message／receipt IDs，控制操作含稳定裁决，不存正文、密钥或绝对路径。
- 同ID异kind／参数409；结果与实际修改同事务提交。返回当前queue快照另行读取，不能将历史结果携带的版本当当前状态。
- 先检查当前访问及删除围栏，再重放既有操作；重放只返回原结果，不因fence过期产生新写入。

### 当前Run输入关联

`agent_interactive_run_input`：workspace_id、session_id、run_id、receipt_id；PK `(run_id,receipt_id)`；两条复合FK分别指Run作用域和receipt作用域，均ON DELETE RESTRICT。

- 新注入和旧输入续接都建立关联；关联不表示再次创建user或修改originRun。
- 续接Run的trigger_message_id引用最早未确认receipt的既有user；所有当前祖先链未确认输入一次性纳入，身份必须一致。
- 普通交互Run的trigger来自新注入队首；未确认输入存在时，后台推进器不得把queued另起新Run绕过它，只能等待显式resume。

### 模型／fallback输入快照绑定

`agent_queue_input_binding`字段：workspace_id、session_id、assistant_message_id、run_id、snapshot_hash、input_revision、source、state、replaces_assistant_id、created_at。

- PK assistant_message_id；UNIQUE `(workspace_id,session_id,assistant_message_id)`；FK message origin scope及Run scope均RESTRICT；replaces_assistant_id自引用binding ON DELETE SET NULL。
- source枚举worker_model/local_fallback；state枚举active/superseded/confirmed。hash来自可信上下文、有效输入receipt集合、投影版本及必要附件集合；不存凭据。
- `agent_queue_model_input`字段workspace_id、session_id、assistant_message_id、receipt_id；PK `(assistant_message_id,receipt_id)`；两条scope FK分别指binding与receipt，前者CASCADE、后者RESTRICT。
- 新建Assistant与建立binding／关联同事务；只允许当前active Assistant的合法完成事务确认其绑定收件。
- replaceStreamingAssistant必须在替换消息／head的同一事务继承相同snapshot和输入集合，新binding active、旧binding superseded；保留旧关联供重放验证，不能让旧Assistant释放保护。
- 相同替换请求回包丢失，重放必须同时验证新旧消息、snapshot_hash、输入集合和替换关系；不创建第三个Assistant。
- resume/recovery先按本次实际上下文校验绑定完全相同；不能证明相同时走既有replace路径并绑定重新准备的实际快照，旧binding保持superseded。不能在同一Assistant上静默换输入集合。
- provider失败／取消／提交未知不确认；合法工具响应完成和纯文本裁决都原子确认；local_fallback仅在本地回显完成事务标记来源local_fallback。
- 准备图片时校验可信字节摘要与receipt附件摘要一致，并冻结实际读取的buffer用于同一次尝试及普通retry；recovery重读须重新校验。路径／inode相同但字节被同UID改写时暂停attachment_integrity_failed，不用旧snapshot确认变更后的内容；仍可显式放弃，不自动unlink。

### Run扩展

`agent_run.interactive_queue_enabled INTEGER NOT NULL DEFAULT 0 CHECK IN(0,1)`，仅新Web队列Run为1；subtask／定时任务／旧强制触发／手动压缩为0。trigger只表示触发身份，不再单独决定图片／保护输入集合。

### 其余关联表与独立账本DDL

以下补齐上述字段定义的父键／FK；替换自引用的同scope由权威replace事务复核，不因全局ID唯一就省略校验。

```sql
create table agent_queue_operation (
  workspace_id text not null, session_id text not null,
  operation_id text not null,
  kind text not null check(kind in ('stop','resume','abandon','prepare','inject','complete_or_continue')),
  request_hash text not null, result_json text not null, created_at integer not null,
  primary key(workspace_id, session_id, operation_id),
  foreign key(workspace_id, session_id)
    references agent_session_queue_control(workspace_id, session_id) on delete cascade
);
create table agent_interactive_run_input (
  workspace_id text not null, session_id text not null,
  run_id text not null, receipt_id text not null,
  primary key(run_id, receipt_id),
  foreign key(workspace_id, session_id, run_id)
    references agent_run(workspace_id, session_id, run_id) on delete restrict,
  foreign key(workspace_id, session_id, receipt_id)
    references agent_user_message_receipt(workspace_id, session_id, id) on delete restrict
);
create table agent_queue_input_binding (
  workspace_id text not null, session_id text not null,
  assistant_message_id text primary key, run_id text not null,
  snapshot_hash text not null, input_revision integer not null check(input_revision >= 0),
  source text not null check(source in ('worker_model','local_fallback')),
  state text not null check(state in ('active','superseded','confirmed')),
  replaces_assistant_id text, created_at integer not null,
  unique(workspace_id, session_id, assistant_message_id),
  foreign key(workspace_id, session_id, assistant_message_id)
    references agent_message(workspace_id, origin_session_id, id) on delete restrict,
  foreign key(workspace_id, session_id, run_id)
    references agent_run(workspace_id, session_id, run_id) on delete restrict,
  foreign key(replaces_assistant_id)
    references agent_queue_input_binding(assistant_message_id) on delete set null
);
create table agent_queue_model_input (
  workspace_id text not null, session_id text not null,
  assistant_message_id text not null, receipt_id text not null,
  primary key(assistant_message_id, receipt_id),
  foreign key(workspace_id, session_id, assistant_message_id)
    references agent_queue_input_binding(workspace_id, session_id, assistant_message_id) on delete cascade,
  foreign key(workspace_id, session_id, receipt_id)
    references agent_user_message_receipt(workspace_id, session_id, id) on delete restrict
);
```

```sql
-- 基础schema独立实体，无Workspace／Session／receipt外键。
create table agent_attachment_publication_intent (
  id text primary key,
  workspace_id text not null, session_id text not null, client_request_id text not null,
  image_position integer not null check(image_position between 0 and 3),
  payload_hash text not null, byte_sha256 text not null,
  attachment_id text not null unique, storage_key text not null, workspace_dir_name text not null,
  byte_size integer not null check(byte_size between 1 and 10485760),
  media_type text not null check(media_type in ('image/png','image/jpeg','image/webp')),
  state text not null check(state in ('reserved','publishing','published','retained',
    'released_unpublished','released_offline_maintenance')),
  retention_code text, publisher_generation text not null,
  owned_dev text, owned_ino text, receipt_id text,
  maintenance_id text, released_at integer,
  created_at integer not null, updated_at integer not null,
  unique(workspace_id, session_id, client_request_id, image_position),
  check((state='released_offline_maintenance' and maintenance_id is not null and released_at is not null)
     or (state<>'released_offline_maintenance' and maintenance_id is null and released_at is null)),
  check((owned_dev is null and owned_ino is null) or (owned_dev is not null and owned_ino is not null)),
  check(state<>'published' or (owned_dev is not null and owned_ino is not null))
);
create index idx_agent_publication_charge on agent_attachment_publication_intent(state);
```

所有留存预留事务以该表非释放状态SUM为权威，不能另维护会在回滚时漂移的内存计数。

## 持久停止屏障与精确运行身份（H5）

本节是本需求的窄增量，不是现有能力。DB terminal/converge、既有吞错cancelSession、Session级cancelSessionAndWait以及短时handoff互斥都不能证明旧Runner退出；不以重启整个Worker解决单Session停止。

### 实体与可执行DDL

以下DDL依赖上面的Run作用域唯一键、control及operation。runtime实例属于DataDir基础实体，身份／退出证据不得被Agent域重建或Workspace级联抹除；其余表受显式清理顺序保护。

```sql
create table agent_runtime_instance (
  runtime_instance_id text primary key,
  owner_api_instance_id text not null,
  runtime_kind text not null check(runtime_kind in ('worker','local_fallback')),
  state text not null check(state in ('starting','ready','unknown','exited')),
  process_identity_json text,
  exit_proof_kind text check(exit_proof_kind in ('child_exit','local_shutdown','offline_exit')),
  exit_proof_id text, exit_proof_json text, exit_observed_at integer,
  created_at integer not null, updated_at integer not null,
  check(coalesce((state='exited' and exit_proof_kind is not null
    and exit_proof_id is not null and exit_proof_json is not null and exit_observed_at is not null)
    or (state<>'exited' and exit_proof_kind is null and exit_proof_id is null
    and exit_proof_json is null and exit_observed_at is null), 0))
);
create table agent_run_runtime_admission (
  workspace_id text not null, session_id text not null, run_id text primary key,
  runtime_instance_id text,
  state text not null check(state in ('unbound','bound','closed','retired')),
  created_at integer not null, updated_at integer not null,
  unique(workspace_id, session_id, run_id, runtime_instance_id),
  foreign key(workspace_id, session_id, run_id)
    references agent_run(workspace_id, session_id, run_id) on delete restrict,
  foreign key(runtime_instance_id) references agent_runtime_instance(runtime_instance_id) on delete restrict,
  check(state<>'unbound' or runtime_instance_id is null),
  check(state<>'bound' or runtime_instance_id is not null)
);
create index idx_agent_runtime_admission_session
  on agent_run_runtime_admission(workspace_id, session_id, state);
create table agent_session_stop_barrier (
  workspace_id text not null, root_session_id text not null, operation_id text not null,
  state text not null check(state in ('pending','unknown','quiescent')),
  targets_hash text not null check(length(targets_hash)=64 and targets_hash not glob '*[^0-9a-f]*'),
  accepted_queue_version integer not null check(accepted_queue_version>=0),
  last_error_code text,
  created_at integer not null, updated_at integer not null, resolved_at integer,
  primary key(workspace_id, root_session_id, operation_id),
  foreign key(workspace_id, root_session_id, operation_id)
    references agent_queue_operation(workspace_id, session_id, operation_id) on delete restrict,
  check((state='quiescent' and resolved_at is not null and last_error_code is null)
    or (state in ('pending','unknown') and resolved_at is null))
);
create index idx_agent_stop_barrier_pending
  on agent_session_stop_barrier(state, updated_at);
create table agent_session_stop_target (
  workspace_id text not null, root_session_id text not null, operation_id text not null,
  target_session_id text not null, run_id text not null, runtime_instance_id text not null,
  state text not null check(state in ('pending','unknown','quiescent')),
  evidence_kind text check(evidence_kind in ('rpc_quiescent','instance_exit')),
  evidence_id text, evidence_json text, confirmed_at integer,
  last_error_code text, updated_at integer not null,
  primary key(workspace_id, root_session_id, operation_id, target_session_id, run_id, runtime_instance_id),
  foreign key(workspace_id, root_session_id, operation_id)
    references agent_session_stop_barrier(workspace_id, root_session_id, operation_id) on delete restrict,
  foreign key(workspace_id, target_session_id, run_id, runtime_instance_id)
    references agent_run_runtime_admission(workspace_id, session_id, run_id, runtime_instance_id) on delete restrict,
  check(coalesce((state='quiescent' and evidence_kind is not null and evidence_id is not null
    and evidence_json is not null and confirmed_at is not null and last_error_code is null)
    or (state in ('pending','unknown') and evidence_kind is null and evidence_id is null
    and evidence_json is null and confirmed_at is null), 0))
);
create index idx_agent_stop_target_session
  on agent_session_stop_target(workspace_id, target_session_id, state);
create index idx_agent_stop_target_instance
  on agent_session_stop_target(runtime_instance_id, state);
```

- UUID在可信服务层验证非空且格式正确；state迁移、不可变运行绑定、operation.kind=stop和targets_hash内容由权威事务验证，不靠DDL字符串长度冒充完整协议检查。
- barrier的targets_hash是全部固定目标的摘要；精确RPC按实例分组，另计算固定分组hash，算法见04。证据JSON只含协议身份、hash、proofId／安全退出元数据，不存token、正文或工具参数。
- closed只表示禁止新admission/enqueue，不表示runtime退出；retired必须有匹配精确quiescent／实例退出证据，或本协议能证明从未绑定且不曾发送的原子关闭。runtime_instance_id一旦非NULL永不重绑；重试仍定位原实例，不把同Run转投新Worker。

### 可信实例与退出证明载体

- Manager每次spawn前生成独立、不可复用runtimeInstanceId UUID，持久starting行和owner_api_instance_id，再通过受保护启动参数交给该Worker；认证握手必须回显匹配UUID及协议版本，且Manager核对当前受控进程后才持久ready；不能从历史ready行随意挑实例入队。它不是analyticsProducerGeneration或私有childEpoch；可窄扩展ChildLifetime保存runtimeInstanceId与进程身份，但不得把现有字段当持久证明。
- process_identity_json记录Manager实际spawn所观察的PID、spawnObservedAt与独立spawnNonce，绑定不可复用runtimeInstanceId及owner API实例；starting先保存nonce与观察时间，ready保存该原ChildProcess的PID。在线退出只接受原句柄的真实exit回调及匹配的实例、nonce、观察时间、PID，不读取/proc，不增加原生依赖。PID只作定位，不能单独作退出证据；不向公开快照暴露这些元数据。
- **S3实施调整**：OS boot ID／process start identity改为离线核验可记录的增强证据，而非声称生产已采集的必填字段。本次单managed runtime内，独立UUID＋spawnNonce＋原ChildProcess句柄已足以关联在线真实退出，无需额外OS读取。API重启丢失原观察能力且无已提交证明时保持unknown；缺少OS字段、新PID或PID不存在均不能自动解除屏障。
- ChildLifetime对**该ChildProcess对象**的真实exit事件生成exit_proof_id，持久child_exit证据（原实例UUID、owner API UUID、原进程身份、exit code/signal、观察时间），提交后才能作为解除屏障证据。若先崩溃未落盘，恢复不能猜测该证据存在。failed spawn且从未ready／admit可按未执行处理，不捏造exit。
- fallback每次API生命周期生成新UUID和同样实例行；pre-listen不收敛Run／queued工具且admission关闭，真实onListen执行统一恢复；Worker在可信ready后恢复。正常关闭停止准入和推进，最多等待本地drain 1秒；超时将实例／屏障保留unknown，不出local_shutdown。只有全部受跟踪本地Runner finally完成后才持久local_shutdown证明。API退出本身、重启后新UUID不是旧fallback退出证明。
- API重启只信已提交证明；新ready、健康、PID不存在、端口变化或analytics快照均不能代替。能认证访问原UUID实例时可重复精确RPC；不能确认原实例时保持unknown。启动恢复发现旧未retired admission而无覆盖屏障时，也按同一固定目标事务补记恢复Stop（reason=startup_recovery，先查覆盖再建，持久operationId重放），不能只标DB失败后允许resume；不自动续跑。
- 离线退路：停用API准入／后台推进，取得DataDir及相关Workspace排他维护权并备份；核对原实例持久身份。若原实例仍在，用可信握手核对UUID与进程启动身份，持有该进程的稳定OS句柄并由操作员显式停止、观察真实退出；或使用原观察者已持久留下的可信退出凭证。维护事务严格校验原身份JSON形状及与原持久身份完全一致，保存maintenanceId、observer、exclusiveMaintenance、verification及观察时间为offline_exit，再逐屏障匹配。不能只凭PID不存在／新generation写证明；缺少可核验证据就继续unknown，向用户说明需诊断，不提供在线force-resume。本次不新增常驻进程监督框架，也不自动执行维护／杀进程。

### 原子admission与固定cascade

- 所有可能影响该Session的Run（含旧强制启动、nested、Worker queued派生Run、fallback）创建时登记unbound admission；**任何实际向runtime发送enqueue之前**，同一SQLite写事务核验Run有效、删除围栏、相关祖先／目标Session无未解除屏障，CAS unbound→bound并固定ready实例UUID。不存在“已向runtime发送、DB还未绑定”的合法状态。
- Stop在同一写事务中以根Session当前active Run→parentRunId子树为取消权威（复用listActiveSessionIdsForCancel的规则），先固定runId；仅当前权威子树中的unbound可原子关闭。再沿根Session的Run lineage合并真正绑定实例且未retired的旧执行，以及该root已有未解除Stop targets；DB terminal但Runner未退仍覆盖。历史child只有DB running且admission unbound、从未绑定／发送，不是旧runtime证据，不得先选历史Session再扫描取消其全部Run。nested的parent Run关系必须在创建事务就落在既有权威cascade关系中，不能等Worker运行后才临时发现；queued与DB已terminal但Runner未退出均不能漏。
- 该事务关闭相关Run admission；unbound→closed且无绑定可证明从未发送，不需要RPC；已bound的固定(sessionId,runId,runtimeInstanceId)写入target。然后持久Stop operation、barrier，对root及target Session控制行均写paused(user_stop)、每Session增一次queueVersion，并写DB terminal intent／取消（保留已提交正常终态），一次提交。纯unbound／无目标时也有operation和quiescent barrier，operation内部稳定结果另记notAdmittedRuns的sessionId/runId与原子关闭理由（公开只返回targetCount），admission closed/NULL不可重开；证明来自原子关闭发送窗口，而非“DB已terminal”。
- 绑定事务先提交：Stop必捕获固定实例，即使enqueue尚未发送／回包未知；Stop先关闭：后到绑定和enqueue准备失败。已在途的旧enqueue由Worker tombstone及有效Run admission拒绝。Stop事务后新nested创建必须同时校验父Run fence、父祖先屏障，不能产生未列入固定集合的新子Run。
- Worker收到enqueue必须验证预期实例UUID、可信admission和有效Run fence；admission检查到本地queued/controller登记之间与精确取消安装tombstone在同一Runner串行临界区内完成。网络校验可在临界区外等待，但本地登记前必须再查tombstone；无await切开“最后检查→登记”。pump、nested入口也使用同一检查，不能绕过注册。
- 新Stop各自独立记录，不扩大或改写旧Stop目标；同root的新记录复制该root尚未解除屏障中的目标并合入当前cascade，新operationId再次增暂停版本。各自按完整固定集合确认，Session以所有相关未解除barrier的并集阻塞；不同root如有重叠目标也保持独立，不因此复制无权威cascade关联的其他目标；旧Stop确认只更新自己的记录，不清新屏障。同Run可有多个Stop目标记录，runtime tombstone可共享，但证据必须按各自operation/hash匹配。

### 精确取消、调解与解除

- 采用04新增精确cancel-and-wait；先在指定实例为固定Run安装**整个实例生命周期保留**的tombstone，再按runId移除queued、abort精确controller并等待root/nested finally。新增runId级跟踪注册表覆盖nested，不复用仅主队列activeRunIds作为全集；不得按Session重选当前执行或清除该Session所有queue。
- quiescent仅指目标已无queued/running/controller/nested、进行中的登记或可继续调度／写回的Runner任务；所有相关异步写回必须受追踪并settle或fence拒绝后才出证。不能因某一瞬间不存在就确认，必须先关闭迟到enqueue窗口。
- 每个barrier固定按实例分组请求；单API调解按不可变(workspaceId,rootSessionId,operationId)游标轮转，每轮最多32项／1秒、每root Session至多一组；实例组也轮转，失败按500ms至30秒有界指数退避，旧unknown不占死首页。内存游标重启归零只影响重试顺序，不改变持久目标和证据。持久pending表示尚待确认，首次可能还未发RPC；RPC返回pending必须已安装tombstone但目标尚未退出。unknown是传输／超时／实例或协议不确定。后台仅扫描未解除项，以有界退避重试**同operationId、同原实例、同固定targets/hash**；每Session每轮至多一组，失败安全枚举日志且不忙轮询。公开旧Stop重试只读重放，不承担重发取消责任。
- 响应丢失不算成功；重复RPC先核对相同参数，重用tombstone并重新观察同目标。只有匹配operation、实例、固定集合hash的quiescent，或该实例持久真实exit证明经本条barrier/targets独立匹配，才能事务标target quiescent并保留证据；所有目标已确认才标barrier quiescent。部分确认不允许解除整个屏障，quiescent证据不可被迟到pending/unknown覆盖。
- 所有相关屏障解除只是取消阻塞，control仍paused，不自动active或启动queued；queueVersion在可见屏障状态变化时，对root及固定target涉及的全部Session控制行各递增一次，保证聚合快照同版本内容一致。证据复制／重试计数等不改变快照的更新不必增版本。新resume仍须新版本CAS、无有效／待收敛Run及原有工具安全检查。
- pending/unknown期间，对root及target Session的运行／历史变更入口统一事务围栏：resume、abandon、自动推进、旧messages／runs/trigger、scheduled、nested创建、revert、fork、手动压缩、设置可见性等修改均拒绝；受理新queued、取消queued、只读及Stop幂等／新Stop允许。仅匹配的fenced终态清理、证据／屏障调解和删除围栏收紧可写，不能借内部入口创建执行或改写历史。Workspace删除不得清除证据、释放lease或绕过该屏障。

### 工具边界与fallback

- Runner退出不等于工具进程／远端副作用撤回。Git可能processStopConfirmed=false但Runner finally已结束，此时本屏障可确认Runner退出，**既有Git unknown、lease和Workspace删除保护原样保留**，新的执行仍受既有工具保护；不得顺带清锁或把工具标成功。
- bash逃逸子进程、MCP／remote-plugin不支持abort、已发送远端动作不在exact-stop保证内。不承诺回滚副作用或全局回收；MCP仍未返回且Runner仍running时只能pending，不能假称idle。
- fallback复用同实体和admission，按runId精确移除本地queued、等待目标当前回显任务finally，实例内tombstone拒绝旧enqueue；不增加provider／工具能力，不回退到Session级清队列。

## 受控恢复：两个闭合出口

### 新发送承接已有输入（resume兼容）

正常发送在Stop代际匹配、所有相关停止屏障解除、旧Run DB完全terminal且实际执行drained、既有工具安全检查通过、Workspace可写、身份和静态输入／原有发布记账校验通过后，在最终receipt事务内原子选择（兼容resume仍独立CAS）：

| 状态 | 动作 |
| --- | --- |
| 有未确认正式输入（无论是否queued） | 创建新的交互续接Run，不创建user；引用最早未确认user作为trigger，关联全部未确认输入；queued保持FIFO等待安全边界 |
| 无未确认输入，有queued | 恢复active，按普通队首激活路径推进 |
| 发送前两者都没有 | 本次receipt进入queued，恢复active后普通激活；兼容resume则仅解除暂停不建Run |

- 续接权威为AgentQueueRecoveryStore共享激活方法，不能调用“必定插入新user”的原激活事务。新发送把receipt、暂停解除、Run和输入关联放在最终附件publication commit同步事务；兼容resume独立事务保存原control CAS和操作结果。
- 事务外复用同Run enqueue未知结果对账；新发送按clientRequestId receipt先去重，兼容resume按operationId重放原runId，二者都不重新激活。
- 仅未确认输入能触发空队列续接，全部confirmed／abandoned时不能再次触发旧输入。
- 不回放旧tool executions，不恢复旧Run；历史工具结果仍作为上下文，外部副作用不撤销、不承诺exactly-once。
- API不做精确token适配；Worker在实际请求前执行下述保守预算。仍不可容纳时再次安全暂停，用户可选择放弃，不能无限后台重试。

### 放弃全部当前未确认输入

- 单一对象范围：当前有效正式祖先链中全部 `injected+unconfirmed` 收件，不支持选部分；请求只携带workspaceId、operationId、expectedQueueVersion、expectedUnconfirmedInputSetHash和`confirmIrreversible=true`，不接收预期ID数组。服务端同事务重算完整集合并按04唯一canonical定义比对hash。
- 仅所有相关停止屏障已解除、无有效Run（含无terminal-intent待收敛）、Workspace可写时允许。集合／版本变化409，无副作用。
- 放弃不依赖旧Agent/model仍有效、上下文窗口或留存剩余额度；否则配置删除／超限会再次堵死恢复出口。只校验范围、停止屏障已解除、无Run、版本／集合和显式确认。
- 同事务将confirmation_state改abandoned、写abandoned_at、持久paused(inputs_abandoned)、递增queueVersion及操作结果；不改receipt.status、消息图、originRun或确认来源。
- queued保持原身份及顺序，不自动取消或执行。放弃后要推进queued需正常新发送（兼容resume仍保留）；无queued时正常发送新输入。
- 已confirmed输入一律不允许放弃；不是“删除用户历史”、不是伪造确认、不是撤销工具。
- 有效模型上下文统一排除abandoned收件的user／附件；历史timeline仍展示。主PromptContext、primary-materializer、compaction source、provider私有replay必须使用同一`effectiveInputPolicy`。
- 与abandoned输入绑定的未完成／superseded Assistant不得被provider replay恢复；原始持久记录保留，投影层排除。已合法完成Assistant会使输入confirmed，因此不会被放弃。
- abandon/resume执行control版本CAS；Stop共用控制事务和操作幂等，但安全优先、不带预期版本。resume先提交后全新Stop仍可成功，最终暂停并取消当时有效Run；Stop先提交则旧版本resume/abandon冲突。
- 同一Stop operationId重试仅重放原结果，不重新暂停或发runtime取消；新用户停止使用新operationId。每个全新Stop无Run或已paused也持久暂停并增版本；同ID重放不增版本。已有正常terminal intent不得被改写cancelled。
- Stop与inject／正常完成均在有效Run fence及SQLite事务序列下裁决，交错明细见D-STOP；短时handoff互斥可保留，但安全性依赖持久停止屏障、admission和精确固定目标，旧公开Stop重放不执行取消副作用。

### 有效输入策略的唯一实现

- API在一次可信上下文快照内生成 `interactive-input-policy-v1`：excludedMessageIds、protectedInputMessageIds、mediaIncludedMessageIds、inputReceiptIds及inputSetHash，共享内部契约传给Worker。
- 纯投影选择函数在共享包内唯一实现，主projector、Worker primary-materializer、compaction source及provider replay均调用，不各写一套abandoned／trigger判断。
- 历史元数据按同Workspace正式祖先messageId映射，包括fork共享来源；不能只查新Session receipt而复活来源abandoned输入。此读取不授予跨Session注入权限。
- API验证receipt集合／策略版本／输入revision；动态工具／system完整hash由受信任Worker提供并持久用于重放，不假称API有工具影子。
- confirmation_source由受保护Worker完成入口或本地fallback专用能力端口决定，公共请求不可指定，本地入口不能伪称worker_model。

## 预算：新增 `queue-input-estimator-v1`

### 现状与限制

- 现有runner的自动压缩触发看 `lastResponseTotalTokens`，不是当前完整请求的精确估算。
- 现有estimator-v1按UTF-8字节/3、消息／parts固定成本、图片1024及10%余量估算；planner固定保留尾部，不能直接保证新队列输入安全。
- 动态工具定义在Worker发现，API没有实际工具schema；禁止在API维护影子工具快照或承诺激活前精确适配。

### 唯一公式与来源

本次新增Worker准备版本 `queue-input-estimator-v1`，不是精确tokenizer，也不保证provider绝不超限。

```text
W = profile.model.contextWindowTokens（必须为有限正整数）
R = buildModelRuntimeOptions最终aiSdk.maxOutputTokens，若未设置则min(4096, max(1, floor(W/4)))
C = floor(0.90 * W)
E = ceil(1.25 * (ceil(B/3) + 8*M + 4*P + 8*Tcall + 8*Tresult + 8192*I + 256))
可提交条件：R为正整数、R < W，且E + R <= C
```

- R显式写入实际模型请求；`options.aiSdk.maxOutputTokens`优先，其次现有兼容的顶层maxOutputTokens。缺省R和90%/25%余量为本次设计常量，不是SDK现有默认。
- W缺失／非数／无效，或显式R无效、R>=W，暂停`budget_configuration_invalid`；不猜上下文窗口，不套1或128k兜底。
- B是本次实际准备请求的canonical JSON UTF-8字节：完整system prompt、同份工具名称／描述／inputSchema、有效消息、tool results、provider replay文本／不透明加密字符串。key排序、数组保序，无密钥／URL鉴权字段。图片二进制／base64不计入B，以可信attachment ID、mediaType、字节数的固定描述替代。
- 预算视图固定为{systemMessages,messages,tools,providerReplay}：system非空时规范为一条system消息和一个text part，空时数组为空；普通字符串content规范为一个text part，原parts数组保序。tools为实际冻结工具的name/description/inputSchema数组，按name排序后也用于真实请求构建；非JSON值拒绝，object key按Unicode字典序排序，JSON紧凑编码、不转义普通非ASCII字符。
- M为systemMessages及messages条数，P为这些消息content的parts数（含text、image、tool-call、tool-result；工具schema不另算part）；Tcall/Tresult为其中相应part个数。
- 图片二进制替代形状固定为{type:"budget_image",stableRef,mediaType,byteSize}，stableRef为可信attachmentId或view_image的可信Workspace相对引用；每个实际传给模型的图片出现计I一次，纯历史路径说明不计I。8192是启发式成本，不是假称真实vision token数。
- providerReplay只放实际准备使用的私有回放项，不重复放仅供调试的副本；opaque加密内容保留原字符串参与计字节，不输出到日志。
- 不透明replay字符串原始UTF-8字节参与B，不能沿旧estimator把encryptedContent替换成占位后忘记其成本。
- 数据来自同份可信PromptContext／有效输入策略及Worker实际动态工具发现结果；预算采用的toolSet／system／replay投影必须与最终provider请求一致，不能预算后重新发现另一份工具。
- 可复用旧estimator的canonical序列化／计数函数，但本公式整体单独版本化、单测；不能把旧estimatedTokens再叠乘两遍。旧estimator仍可用于压缩候选排序，不作为完整请求准入公式。

### 准备与超限流程

- 每安全边界最多评估0..8条FIFO前缀；针对每个候选虚拟上下文发现实际工具，计算公式，选择可容纳的最长前缀并冻结该准备结果。不得跳过队首；候选取消／head CAS变化则重准备。
- 同一准备周期最多尝试一次旧完整轮次前缀压缩，随后重算；planner新增“最早unconfirmed输入前”的硬保护，不得沿原固定尾部策略越界。
- 额外queued先预算再注入。没有任何前缀可放入则queued保留，暂停input_too_large并收敛；不能先注入再摘要新消息。
- 空闲trigger先原子注入再由Worker准备，API只校验输入／图片／容量／可解析身份，不承诺token预检。准备失败时trigger保留injected+unconfirmed；通过新发送或放弃恢复，不永久卡死。
- 已注入unconfirmed输入直到合法确认前保持原文／必要附件，不能因压缩、recovery或primary materialization降级。abandoned才从有效上下文和保护集合排除。
- provider明确context-too-large：本次请求不无限retry，不再自动摘要未确认输入，收敛failed并paused(provider_context_too_large)；输入确认不写入。网络／其他错误继续既有有限重试规则。
- primary-materializer和compaction source的trigger-only媒体分支必须改为同一可信媒体集合；实际模型、预算、压缩源及provider replay都按同一有效策略投影。

## 附件发布留存：安全优先，不自动unlink

### 现状和产品成本

现有 `removeAgentWorkspaceAttachmentFinalFile`明确拒绝unlink：同UID工具可以替换目录项，即使inode匹配也存在竞态。本次不发明安全物理删除协议。

- 取消、放弃、业务DB回滚、发布结果未知、逻辑Workspace删除，均不自动unlink已发布Workspace文件；不得宣称必定回收磁盘。
- 未发布temp仍按既有安全temp清理。
- UI／诊断说明“附件可能因安全原因保留，占用发布留存额度”，只显示字节、状态和安全ID，不泄漏私有路径。

### DataDir独立留存账本

新增 `agent_attachment_publication_intent`，由基础schema维护，**不加入Workspace Agent域重建／删除级联**；无Workspace／Session／receipt外键，逻辑删除后仍保留计费事实。仅本功能的新Web附件走此账本，不追溯承诺覆盖历史附件或用户工具生成文件。

| 字段 | 约束／用途 |
| --- | --- |
| id | TEXT PK，稳定发布reservation ID |
| workspace_id/session_id/client_request_id/image_position | TEXT/TEXT/TEXT/INTEGER，四元组UNIQUE，独立幂等 |
| payload_hash/byte_sha256 | 绑定整个请求与该图片，防同ID异内容 |
| attachment_id/storage_key/workspace_dir_name | 服务端生成／验证的最小可信发布标识；不由客户端提供路径 |
| byte_size/media_type | 实际校验原文件字节数及既有类型 |
| state | reserved/publishing/published/retained/released_unpublished/released_offline_maintenance |
| retention_code | 安全枚举，如outcome_unknown/business_rollback/workspace_logically_deleted |
| publisher_generation | API本次启动ID，防同时重复发布 |
| owned_dev/owned_ino | 已知发布所有权，TEXT保存完整整数；未知可NULL |
| receipt_id | 可NULL审计关联，无FK，不影响账本生命周期 |
| maintenance_id/released_at | 仅人工离线释放时必填，保留维护审计标识 |
| created_at/updated_at | 服务端时间 |

唯一总额：`AGENT_QUEUE_ATTACHMENT_RETAINED_MAX_BYTES = 1 GiB`，对同DataDir本表所有非released_unpublished且非released_offline_maintenance行SUM(byte_size)。reserved/publishing/未知／已注入／已取消／逻辑删除都占额度，不能因pendingBytes减少而释放。

### 顺序与崩溃语义

- 先完成安全temp上传／字节摘要，再在独立SQLite事务一次性预留整个请求所有图片额度；容量不足507 `AGENT_ATTACHMENT_RETENTION_CAPACITY_EXCEEDED`，不发布、不新建receipt。
- 此预留事务必须先独立提交，不能包含在随后可能回滚的业务受理事务中。两个并发预留同总额约束串行，不越1GiB。
- 发布前另一次持久CAS reserved→publishing；只有胜者能调用现有发布器。业务受理事务中登记attachment/receipt及发布信息；成功后账本标published并关联receipt。
- 准入、预留到发布／受理提交受既有Workspace mutation/admission围栏保护，发布前及业务事务内复核删除状态；删除不能与在途发布失控穿插。删除胜出且能证明未调用发布时仅释放未发布reservation；否则保持留存，禁止删除后继续写Workspace。
- 中断／未知结果：publishing保留额度，恢复转retained(outcome_unknown)。不重试发布同一intent，不自动unlink。先查receipt确定业务是否成功，再返回既有收件或诊断需维护。
- 同requestId重试复用同intent与已知安全发布文件；重新验证可信文件和owned身份后才可复用，不生成另一文件。未知或已替换不能证明安全时返回409 `AGENT_ATTACHMENT_PUBLICATION_UNCERTAIN`，仍计额度。
- reserved且能证明该generation从未跨入publishing／没有进行中发布者，或发布器确证“未尝试／未发布”，才可标released_unpublished；不能仅凭路径不存在或DB回滚判断未发布。
- 已经发布及可能发布的记录不自动释放；取消／abandon／Workspace逻辑删除只更新retention_code，历史附件记录与账本审计不得用于危险unlink。
- 临时文件失败／取消仍按已有temp清理；新的同请求上传先做指纹核验，不因随机tempId生成额外发布reservation。
- released_unpublished仅在确证从未发布时可按原hash、同intent重新预留并再次检查总额；已发布／retained／released_offline_maintenance不得用同request再发布，缺少可安全复用原文件时409，不重建intent绕过墓碑。

### 空间耗尽与离线维护

- 达1GiB后文本仍可受理，新图片发布明确507并保留草稿；错误显示“附件留存额度已满，需要离线维护”，不无限重试。
- 这不是整个磁盘安全保证，也不涵盖历史文件、工具自行生成内容或外部修改；数据库／temp仍可能遇到ENOSPC并安全失败。
- 本次不实现危险清理工具。离线维护必须显式停API、Worker及所有会修改相关Workspace的同UID工具，并获得排他访问和一致DB备份；操作员自行决定文件清理，不由本功能执行unlink。
- 解除已发布额度是人工审核的非自动维护动作：核对稳定intent与原有所有权／文件身份、确认相关文件已由操作员处理且无保留引用，记录维护审计与精确字节；无法证明排他性／身份／处理结果则保留额度。不能仅凭在线stat、改Workspace名称或逻辑删库自动减额。
- 维护后的手工账本调整必须在独立事务内标released_offline_maintenance并保存maintenance_id/released_at，保留原意图墓碑和维护记录，不删除request发布幂等身份；实现阶段只定义/验证读取与错误契约，不要求提供修改工具。

## 生命周期、删除与迁移

- Worker路径：先关闭推进／新admission→注册持久实例并验证ready握手→恢复删除围栏、DB旧Run收敛及停止屏障；按原UUID对账，同实例精确RPC或已持久真实exit证据才可确认，未知保持暂停。随后启动停止调解器和仅扫描无屏障Session的推进器；新ready本身不清旧屏障。
- fallback路径：runPreListen后，API onListen创建本生命周期实例UUID、等待local DB恢复和停止屏障恢复，再启动调解器／无屏障Session推进器。旧API实例缺退出证据保持unknown，新UUID不继承旧身份；不能只在Worker ready恢复。
- 两路径onClose先封admission、停推进／注入；对当前固定Run执行有界精确取消等待，未确认项持久pending/unknown。等待runtime／Manager的退出证据写任务settle，或明确放弃落盘且保持unknown后，才停调解器、关闭analytics/DB，禁止关DB后晚写。fallback全部本地finally确认才记local_shutdown；不以关闭开始作为退出证据。
- 两路径都不自动续跑失败旧Run；queued active、无停止屏障且无未确认输入可推进，paused不推进，未确认输入等待显式续接或放弃。
- fallback不调用provider、不发现工具、不执行Worker token预算；仍执行输入／图片／容量与可信附件检查。回显规范为原正文及图片数量／安全文件名摘要，明确“本地回退已收到”，不把数组转成[object Object]或声称理解图片；该回显合法完成事务才source=local_fallback确认。
- Workspace删除可先收紧准入，但有相关停止屏障或工具unknown/lease时不得清理数据；待Runner证据和既有删除保护均通过，先删除stop_target→stop_barrier→run_runtime_admission，再删queue model input→binding（先解除自引用）→interactive_run_input→operation→receipt附件关联→receipt→control，最后按既有消息／Run/Session/附件顺序清理。独立runtime_instance身份／退出证据不级联；仅允许已满足上述证明的显式清理，不靠FK级联擦除pending。独立publication_intent保留并标逻辑删除，不受FK级联。
- 当前schema=25；显式非破坏升级、更新分类器及canonical签名；不得意外rebuild。publication账本属于基础schema安全迁移和版本检查，不能随Agent域重建丢掉额度。
- 从现版升级保留全部历史、Run、附件和旧client_request；旧Run交互标志0，老数据不伪造确认或发布额度。旧协议没有可信实例绑定，不能把其在途Run伪装成“unbound所以从未发送”；上线前必须有原runtime可核验退出／排空证据，否则保持恢复未知并禁止新执行流量。该部署门槛不是日常Stop重启Worker的替代协议。
- 未知schema拒绝；回滚使用一致DB／文件快照，旧二进制不得强开新schema。

接口见[协议](04-api-and-worker-protocol.md)，具体恢复、重试、留存和DDL验收见[验收](06-testing-and-acceptance.md)。

## S8：最小幂等元数据与有界冻结准备（2026-11-10）

最终全面审查指出：S5～S7虽然协议闭环成立，但`agent_queue_operation.result_json`曾重复保存完整prepare响应，违反上文“不存正文／路径”的设计。本节是S8修正，不抹去此前实现差异；**schema仍为26，无新增表**。

- prepare持久结果仅含Run、operationId、prepare／finish裁决、head/revision、preparationSnapshotHash、有序candidateReceiptIds／inputReceiptIds、policy／estimator版本。finish重放完全不依赖内存。
- inject保存稳定receipt／message标识、revision等必要结果；complete_or_continue保存稳定裁决和必要续接边界；resume／abandon保存原动作／对象ID。以上均不再保存queue/items正文。每次返回或重放，在一致读事务重新附加fresh queue。
- 尚未发布的26旧形状采用惰性兼容：在正常重放或注入事务中提取最小元数据、原位最小化，不删除operation幂等墓碑。旧普通prepare没有本进程冻结缓存时返回expired，而不是用当前上下文伪造原快照。
- API进程内按完整workspace/session/run键维护最多一个活动冻结slot，保存原context＋候选，不保存Worker实际工具定义或图片buffer。UTF-8 JSON单条16MiB、总计128MiB，唯一常量位于`frozen-prepare-cache.ts`；这是冻结载荷预算，不等同于整个Node进程RSS上限。满额明确拒绝新prepare，不偷偷淘汰可重试快照。
- 同Run同operation并发singleflight；不同operation在旧异步准备尚未结束时明确stale拒绝。异步读取后再次验证Run、停止围栏及head/revision；释放会使旧flight失效。容量检查在COMMIT前，缓存发布在COMMIT成功后同步完成，失败不得留下假成功或覆盖旧slot。
- 释放只发生于：匹配hash的inject成功提交、新合法准备替换、对应revision的Assistant成功绑定（包含无候选）、finish或安全终态、Workspace消失、API关闭。安全终态／Workspace删除另有按DB状态的有界周期检查；不是按任意TTL淘汰。迟到inject重放不能释放同Run更新边界的slot。
- frozen丢失只影响普通prepare内容重放，不影响原裁决与inject所需最小事实。Worker明确处理expired，以新operation在合法边界重试；不得把expired当finish，也不得放宽Stop／admission屏障。

### 已退出执行的可靠退休通知

`AgentRuntimeRetirementNotifier`仅负责已真实finally退出的固定`runId＋runtimeInstanceId`通知，普通／nested／fallback共用此窄实现；不负责判定DB终态就是退出。最多1024个执行中预留＋待确认身份，先预留再登记执行，满额拒绝新执行，不丢旧通知。通知去重，失败100ms起退避、最高5s，retired=false仍需重试；通知责任与已释放的执行controller分开。shutdown有界等待执行／通知；超时不伪造证明，由Manager对**原实例**真实exit的持久证据收敛遗漏通知。既有未retired admission及Stop未知屏障保持有效。


## H2：容量不足的持久拒绝（S8后复审增量）

原H1／M1／M2／L1／L2已Resolved，退休通知器、最小元数据、冻结缓存方案保持不变。新增H2揭示：明确容量不足若仅返回503，会进入Worker控制写未知结果循环；外层有限prepare次数不能截断该循环。

- 单条16MiB／全API128MiB上限不变，仍不淘汰其他可重试slot。单条超限裁决为`rejected/snapshot_too_large`，总额或1024个在途准备名额耗尽为`rejected/cache_capacity`。
- 新裁决在既有`agent_queue_operation`事务中持久化，内容仅为`{runId,response:{operationId,decision:"rejected",reason}}`；不持久正文、context、candidates、queue，不占用冻结slot，不改schema26。COMMIT失败不能返回假成功，失败替换不释放旧slot。
- 先验证scope并重放已有prepare／finish／expired／rejected，再判断新操作是否能接纳；新操作须通过Run／Stop／安全工具边界／当前head验证。单条／总额检查在上下文异步读取后的权威事务内，在途名额拒绝也在同一类事务内验证当前边界。continue后的空队列finish优先于容量拒绝。
- rejected墓碑不依赖内存，API重启、额度释放或后续队列变化不改变原reason；每次附fresh queue。当前容量不能把旧prepare／finish改判rejected。原prepare冻结内容已释放时仍为expired。
- Worker与fallback将权威拒绝送入现有failed终态及paused队列生命周期，诊断分别为`prepare_snapshot_too_large`／`prepare_cache_capacity`；保留injected未确认及queued，真实finally后沿用原退休通知。用户通过正常新发送或abandon显式退出暂停（兼容resume仍保留），不添加隐式调度或新协调实体。

## Esc增量事务

- schema保持26，`agent_queue_operation.kind`不新增clear。clear用固定receipt IDs＋集合求交提供效果幂等，不保存批量动作日志，不重建operation表／外键。
- `queued-receipt-cancellation.ts`是单条cancel、批量clear及Web Stop共享的唯一取消权威：先验证整组scope，再retain已发布附件、撤销receipt附件授权、清正文、置cancelled并推进queueVersion；不unlink、不减留存额度。
- 新Web Stop显式传内部clearQueued策略，原operation重放最先返回；当前Session queued取消、暂停、admission关闭、acceptedQueueVersion与屏障在同一事务提交。默认通用Stop保持旧行为，不遍历targets清队列。
- `queue-stop-generation.ts`从所有相关持久barrier身份排序hash；无新列、无时间戳猜测。代际随收件请求冻结，最终事务对比，覆盖完整Stop结束后的迟到提交。
- 附件发布仍独立记账；最终同步commit回调组合代际／profile／原恢复安全检查、receipt插入、控制active及必要续接Run／原输入绑定。任何失败回滚业务事务，已发布文件保留。
- `AgentQueueRecoveryStore.activateRecoveredInputs`统一兼容resume与发送的业务规则；发送不另建恢复幂等账本，原clientRequestId receipt墓碑承担重复收件保护。物理handoff仅在提交后复用lifecycle enqueueActivatedRunOrReconcile。
