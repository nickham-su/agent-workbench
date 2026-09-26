---
name: Skill 编写手册
description: 面向模型与开发者的实用指南：如何在 agent-workbench 中创建、组织、加载与维护 skill
---

# Skill 编写手册

本手册说明如何把 Skill 写对、放对，并让模型按需读取。内置 Skill 由应用自带；工作区 Skill 在「上下文管理」中逐项启用，新发现项默认禁用。

## 目录与最小结构

从 workspace 根目录开始探测，父目录相对 workspace 根最多 4 级。任意符合深度要求的目录只要有直属、普通且非软链的 `SKILL.md`，就可成为候选 Skill；workspace 根的 `SKILL.md` 不算 Skill。扫描不跟随软链，跳过 `.git`、`node_modules`、`.agent-workbench`，但允许 `.claude` 等隐藏目录。目录下有直属 `SKILL.md` 时，其后代的 `SKILL.md` 不再形成独立 Skill；后代的 `AGENTS.md` 仍可被探测。

发现只检查文件元数据；启用之后，根说明需可读且非二进制，才会进入模型的可用 Skill 列表。`SKILL.md` 是唯一具有元数据语义的根说明文件。

小型 skill 优先采用平级多文件，减少路径转换：

```text
my-skill/
├── SKILL.md
├── reference.md
├── examples.md
└── checklist.md
```

`SKILL.md` 可以有可选的轻量 frontmatter：

```md
---
name: 我的 Skill
description: 一句话说明这个 skill 解决什么问题
---

# 使用说明
```

- `name` 为空时，展示名称回退为目录名。
- `description` 为空时，skill 仍可用，只是不在模型可用列表显示描述。
- frontmatter 不参与定位；不要把名称当作唯一键。

大型 skill 或确有明确分类时，才使用多级目录：

```text
large-skill/
├── SKILL.md
├── overview.md
└── references/
    ├── api.md
    └── examples.md
```

嵌套目录中的文件（包括嵌套的 `SKILL.md`）在该 Skill 内只是普通辅助文本，不会形成独立 Skill，也不会解析或剥离其 frontmatter。

## 模型如何加载

模型先从可用 Skills 列表选择稳定逻辑标识，再选择可选的根内文件路径：

```json
{
  "skillId": "builtin/skill-authoring"
}
```

内置 Skill 使用 `builtin/<skillDir>`；外部 Skill 的 ID 就是 Skill 目录相对 workspace 根的路径，不带 `workspace/` 或 repo ID：

```text
builtin/<skillDir>
my-skill
repo-a/.claude/skills/review
```

例如 `workspace/repo-a/.claude/skills/review/SKILL.md` 的 ID 为 `repo-a/.claude/skills/review`。首段 `builtin` 为内置命名空间保留，workspace 中 `builtin/.../SKILL.md` 不注册为外部 Skill。移动或重命名目录会改变 ID，需要重新启用。启用只授权该 Skill 的精确 ID；禁用后不能靠猜 ID 读取。

读取根说明和可用文件列表时，省略 `filePath`，传空字符串或仅由空格/tab 组成的字符串，或精确传入 `SKILL.md`：

```json
{
  "skillId": "builtin/skill-authoring",
  "filePath": "SKILL.md"
}
```

根读取会返回根正文和扁平的 `Skill files` 列表。代码块中的每一行都是可直接复制到后续 `filePath` 的完整相对路径：

```json
{
  "skillId": "builtin/skill-authoring",
  "filePath": "reference.md"
}
```

不要传目录、绝对路径、`./`、`..`、反斜杠，或对路径添加首尾空白。辅助文件由 Worker 的通用文本读取器规范化后返回；它们不是字节或换行保真读取。

## 编写建议

- 一个 skill 聚焦一个明确目标，正文先写结论和最小可执行步骤。
- 把较长参考内容、示例和清单放入平级辅助文件，让根说明只保留导航和关键约束。
- 在根说明中准确引用文件路径；路径应能直接复制到 `filePath` 参数。
- 目录名应稳定、短且语义清晰，例如 `plugin-development`、`skill-authoring`。
- 不要放入二进制、密钥、token、隐私数据或高度临时的信息。

## 评审清单

- 顶层目录是否有直属、常规文件类型的 `SKILL.md`？
- 是否优先采用平级多文件，而不是不必要地增加层级？
- 根说明是否包含目标读者、最小步骤和可复制示例？
- 每个辅助文件路径是否是规范相对路径，并适合直接填入 `filePath`？
- 名称和描述是否仅作为展示元数据，而非定位或授权依据？
- 内容是否与当前加载协议、工具 schema 和实际行为一致？
