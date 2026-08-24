# Skills 方案规格说明（双 roots + run 级缓存）v1

本文档定义 agent-workbench 当前期要实现的 Skills 方案，作为研发实现与测试的统一依据。

本文档强调“规格可执行”，并尽量使用纯文本可读表达，不依赖 Markdown 渲染能力。


一、目标与范围

1. 目标
- 提供一个可按需加载的 Skills 机制，减少系统提示词长期堆叠的负担。
- 在保持实现简洁的前提下，支持无限层级扩展。
- 在同一个 run 内减少重复扫描与重复拼接，提升性能稳定性。

2. 本期范围
- 双目录 roots：builtin + workspace。
- 顶级 skill 摘要注入 system prompt。
- 提供统一 skill 工具按 id 读取 skill 或文件。
- runId 级缓存（skills 摘要 + system prompt 静态部分）。

3. 非目标（本期不做）
- 不做复杂权限系统。
- 不做数量限制（skills 数量、children 数量、系统提示词条目数等）。
- 不做同 run 的变更感知刷新（明确接受同 run 不更新）。


二、目录 roots 与节点判定

1. 双 roots（已确认）
- builtin root：项目内 ./skills
- workspace root：<workspaceRoot>/.awb/skills

2. Skill 节点判定（已确认）
- 任意目录中，只要存在 SKILL.md，即判定该目录为一个 skill 节点。
- 该规则适用于任意层级（无限层级）。

3. 顶级 skill 定义（用于 system prompt 摘要）
- 顶级 skill 指 root 下一级子目录中的 skill 节点。
- 仅顶级 skill 参与 system prompt 默认摘要注入。


三、统一 id 体系（skill 与 file 共用）

1. 前缀命名空间（已确认）
- builtin 下的 id 统一前缀：builtin/
- workspace 下的 id 统一前缀：ws/

2. id 规则
- id 为逻辑定位标识，不暴露真实磁盘路径。
- skill 与 file 都使用同一套 id。
- children 返回的子项 id 也必须带同前缀，与父节点来源一致。

3. 示例
- builtin 顶级 skill：builtin/tools/read
- workspace 顶级 skill：ws/deploy
- workspace 子 skill：ws/deploy/k8s
- workspace 同级文件：ws/deploy/template.yaml


四、System Prompt 组装规则

1. 触发时机（已确认）
- 每次请求模型前生成 system prompt（通过 prompt-context 流程）。

2. 注入内容（已确认）
- 注入 builtin 与 workspace 两个来源的“顶级 skills 摘要”。
- 每条摘要包含：id、name、description。
- 同时注入 skill 工具用法说明（例如如何用 id 按需加载）。

3. 路径暴露约束（已确认）
- system prompt 不暴露真实路径信息。
- 不出现 workspace 绝对路径或实际磁盘目录细节。

4. 顶级 skill 摘要字段来源
- name、description 优先来自 SKILL.md frontmatter。
- 若字段缺失：
  - name 可回退为目录名（实现建议）
  - description 可为空字符串


五、Skill 工具规格

1. 工具输入
- 输入参数：id（string）

2. 当 id 指向 skill 节点时
- 返回“当前 skill 正文 + children”。
- 当前 skill 正文：当前目录下 SKILL.md 的正文内容。
- children 永远包含两类：
  a) 同级文件（当前目录下除 SKILL.md 外的文件）
  b) 次级 skill（当前目录下直接子目录中包含 SKILL.md 的节点）
- 以上规则对任意层级 skill 一致生效，不限制深度（无限扩展）。
- 文件 children 不包含 description（已确认）。
- 次级 skill children 包含 id/name/description。

3. 当 id 指向文件时
- 返回文件内容。
- 不返回 children（已确认）。

4. 输出约束
- 对外输出只使用逻辑 id，不输出真实文件系统路径。


六、文件读取限制（参照 read 工具）

1. 复用范围（已确认）
- 复用 read 工具的“文件类型判断（二进制识别）+ 长度限制（例如 50KB、长行截断）”逻辑。

2. 不复用范围（已确认）
- skill 输出不采用 read 工具的行号/尾注格式。
- 即：skill 输出应更干净，面向模型阅读，不强制 read 风格包装。

3. 实现建议
- 将 read 的限制能力抽取为可复用 helper，供 read 与 skill 共用。
- 避免复制逻辑导致阈值/行为漂移。


七、缓存设计（runId 级）

1. 缓存目标（已确认）
- 同 runId 内，skills 顶级摘要只扫描一次。
- 同 runId 内，system prompt 静态部分整体只构建一次。

2. 时间实时替换（A，已确认）
- runtime_constraints 中的“当前时间/时区”每次 prompt-context 请求都实时生成并替换。
- 即：静态部分缓存；时间字段实时。

3. 同 run 变更语义（已确认）
- 同 runId 内不感知变更：
  - skills（builtin/workspace）变更不更新
  - AGENTS.md 变更不更新
  - global prompts 等静态输入变更不更新
- 变更在下一个 run 生效。

4. 并发去重建议（已确认）
- 使用 Map<runId, Promise<...>> 做 in-flight 去重，避免同 run 并发请求重复扫描/重复构建。

5. 清理策略建议（已确认）
- run 完成态清理：completed / failed / cancelled。
- 增加 TTL 兜底，防止异常路径导致缓存残留。


八、争议点与已知风险（本期先接受）

1. children 输出可能过大
- 当前共识：先不做数量限制，遇到问题再治理。

2. system prompt 摘要可能增长
- 当前共识：先不做数量限制，先验证实际负载。

3. 同 run 不感知变更
- 这是明确语义，不是缺陷；需在研发与产品侧保持一致认知。

4. run 级缓存的一致性边界
- 进程内缓存可保证“同进程去重”，多实例部署下不保证全局唯一构建。
- 当前阶段可接受。

5. 路径绕过风险
- 当前策略是“尽量避免暴露路径”，而非绝对禁止。
- 后续若出现明显绕过问题，再评估更强约束。


九、实现落点建议（便于研发排期）

1. API 侧
- 在 prompt-context 组装链路中加入：
  - 双 root 顶级 skills 摘要扫描与注入
  - runId 级静态 system prompt 缓存
  - runtime_constraints 实时替换

2. Worker 侧
- 新增 skill 工具执行逻辑：id -> skill/file 分派。
- 复用 read 限制逻辑 helper，输出保持 skill 自身格式。

3. 共享契约
- 内置工具枚举、schema、路由校验等位置同步增加 skill 工具定义。


十、验收要点（最小可验证）

1. 双目录扫描
- builtin 与 workspace 的顶级 skills 均可出现在 system prompt 摘要。

2. 前缀正确
- 所有摘要项、children 项 id 均带 builtin/ 或 ws/ 前缀。

3. skill 行为正确
- 读取 skill：返回正文 + children（文件 + 次级 skill）。
- 读取文件：返回内容，无 children。

4. 限制逻辑生效
- 二进制文件被拒绝或按约定提示。
- 长文本按限制截断。
- 输出不包含 read 风格行号/尾注。

5. 缓存语义正确
- 同 run 多次请求：
  - skills 摘要不重复扫描
  - system 静态部分不重复构建
  - 时间每次更新
- run 结束后缓存可清理。


附：本文件为当前期规格基线。后续若引入数量限制、变更感知、权限体系，需在 v2 文档中显式更新，不隐式修改本规格。