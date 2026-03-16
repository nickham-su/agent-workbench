---
name: Skill 编写手册
description: 面向模型与开发者的实用指南：如何在 agent-workbench 中创建、组织、加载与维护 skill
---

# Skill 编写手册

这份手册专门回答一个问题：**在 agent-workbench 里，怎样把 skill 写对、放对、用对，并长期可维护**。

适用对象：
- 开发者（要新增或维护 skills）
- 模型（通过 `skill` 工具按 id 读取知识）

---

## 1. skill 应该写在什么位置

写 skill 时，先按下面两个路径示例理解即可：

1) `<workspaceRoot>/skills/new-skill/SKILL.md`
2) `<repoRoot>/skills/new-skill/SKILL.md`

其中：
- 当前目录就是 `workspaceRoot`。
- `repoRoot` 指当前工作区内某个仓库目录的根路径。

建议：先按 `skills/<name>/SKILL.md` 这个最小结构创建，再按需要补充同级文件和子 skill。

---

## 2. 目录/文件格式：怎么组织一个 skill

## 2.1 最小 skill 节点

一个“skill 节点”本质是一个目录，且目录里必须有 `SKILL.md`：

```text
<some-root>/my-skill/
  SKILL.md
```

`SKILL.md` 推荐使用 frontmatter：

```md
---
name: 你的 skill 名称
description: 一句话描述这个 skill 解决什么问题
---

正文内容...
```

- `name`、`description` 建议提供，便于 top-level 摘要注入。
- 正文要写“可操作说明”，不要只写概念。

## 2.2 子 skill 与同级文件

在某个 skill 节点目录下：

- 同级普通文件（除 `SKILL.md`）会作为 `children` 的 `file` 项返回。
- 直接子目录中若包含 `SKILL.md`，会作为 `children` 的 `skill` 项返回。
- 只识别**直接子级**，不是递归整棵树。

示例：

```text
my-skill/
  SKILL.md
  examples.md              # children: file
  prompts/
    SKILL.md               # children: skill
  deep/
    nested/
      SKILL.md             # 不会直接出现在 my-skill 的 children 中
```

## 2.3 指向 file 与 skill 的差别

`skill` 工具读 `id` 时：

- 指向 skill 目录：返回 `SKILL.md` 正文 + `children`
- 指向普通文件：只返回文件内容，不返回 `children`

---

## 3. 加载/探测机制（当前项目真实行为）

关键实现位置：
- Prompt 组装：`apps/api/src/modules/agent/agent.service.ts`
- external roots 探测与设置：`apps/api/src/modules/workspaces/workspace.service.ts`
- `skill` 工具解析：`apps/agent-worker/src/runtime/fileTools.ts`

## 3.1 Prompt 如何知道有哪些 skill

系统会在 prompt 里注入 top-level skills 摘要（`id + name + description`）：
- builtin top-level
- 已启用的 workspace/repo top-level（只统计并注入已启用 roots）

并注入 `skill` 工具用法说明：
- 只允许逻辑 id（`builtin/...`、`workspace/...`、`repo/...`）
- 不应暴露真实文件系统路径

## 3.2 external roots 如何探测

workspace/repo 候选目录遵循统一规则：
- 只看一级目录
- 目录名包含 `skill`（大小写不敏感）
- 必须存在、是目录、非 symlink

并额外返回 `topLevelSkillCount` 作为展示数量：
- 只统计“一级子目录型 skill 节点”（子目录中有非 symlink `SKILL.md`）
- root 直系文件不计数
- 不可读或非文本 `SKILL.md` 不计入；计数允许为 0（目录仍可显示）

## 3.3 模型如何按 id 读取

模型通过内置 `skill` 工具：
- 输入：`id: string`
- 支持前缀：`builtin/... | workspace/... | repo/...`
- 命中 skill 节点返回正文与 children
- 命中文件返回文件内容

---

## 4. 推荐写法（实用）

1) 一页一目的
- 一个 skill 解决一个明确问题（例如“插件开发手册”）。
- 避免在一个 `SKILL.md` 混入多个无关主题。

2) 先结论后步骤
- 先写“什么时候用这个 skill”。
- 再给“最小可执行步骤”。

3) 把“可复制片段”写全
- 配置、命令、模板尽量给完整片段。
- 少写“自行补全”式说明。

4) 路径和 ID 都写逻辑口径
- 对模型优先给逻辑 id（`builtin/...`）。
- 必要时再给物理路径参考给开发者。

5) 稳定优先
- 高频使用的基础手册放 builtin。
- 项目临时/实验性内容放 workspace/repo roots，避免污染内置能力。

---

## 5. 常见坑点

1) 用错文件名
- 不是 `skill.md`，而是 `SKILL.md`（区分大小写）。

2) 目录层级写太深
- children 只看直接子级；深层内容要靠逐层读取。

3) 把二进制/超重内容当正文
- `skill` 工具遵循文本读取限制；二进制不可读。

4) 只写理念，不写落地步骤
- 模型最需要“可执行步骤 + 示例输入输出 + 边界条件”。

5) 没有维护策略
- 文档长期失效比没有文档更危险。
- 建议在正文顶部写“适用版本/最后更新范围”。

---

## 6. 什么时候该用 skill，什么时候不该用

适合放 skill：
- 稳定流程、操作手册、约定规范
- 需要按需加载而非每轮都塞进 system prompt 的长文

不适合放 skill：
- 高频变化且强时效的临时信息
- 需要严格结构化机器消费的数据（更适合 JSON/配置/数据库）
- 涉及敏感信息（token、密钥、隐私数据）

---

## 7. 可维护性建议（团队协作）

1) 命名规范
- 目录名建议短而语义清晰，例如：`plugin-development`、`skill-authoring`。
- 避免含糊命名如 `misc`、`temp2`。

2) 拆分策略
- 一个主 skill + 少量同级文件，是常见且好维护的形态。
- 主题过大时再拆子 skill，不要一开始过度拆分。

3) 评审清单
- 是否有明确目标读者？
- 是否包含最小可执行步骤？
- 示例是否可直接复制？
- 是否与当前代码行为一致？
- 是否暴露了不该暴露的信息？

4) 回归检查
- 每次改动加载机制（id 前缀、探测规则、tool 输出）后，应回看核心 skill 文档是否需要同步更新。

---

## 8. 一个最小模板（可直接复制）

```md
---
name: <Skill 名称>
description: <一句话说明解决什么问题>
---

# <标题>

## 适用场景
- ...

## 最小步骤
1. ...
2. ...

## 示例
```bash
# 命令或配置示例
```

## 常见问题
- 问题A：...
- 问题B：...
```

---

如果你要新增 skill，优先按这份手册执行；如果你要改现有 skill，优先保证“与当前加载机制一致 + 内容可执行 + 易维护”。
