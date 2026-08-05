---
name: Skill 编写手册
description: 面向模型与开发者的实用指南：如何在 agent-workbench 中创建、组织、加载与维护 skill
---

# Skill 编写手册

本手册说明如何把 skill 写对、放对，并让模型以 V2 加载协议稳定读取。

## 目录与最小结构

一个 Skills root 的一级子目录就是一个顶层 skill。每个顶层 skill 的直属 `SKILL.md` 是唯一具有元数据语义的根说明文件。

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

嵌套目录中的所有文件（包括嵌套的 `SKILL.md`）都是普通辅助文本文件，不会形成独立 skill，也不会解析或剥离其 frontmatter。

## 模型如何加载

模型先从可用 Skills 列表选择稳定逻辑标识，再选择可选的根内文件路径：

```json
{
  "skill_id": "builtin/skill-authoring"
}
```

稳定标识只使用下列形状，不使用物理绝对路径：

```text
builtin/<skillDir>
workspace/<rootDir>/<skillDir>
repo/<repoId>/<rootDir>/<skillDir>
```

读取根说明和可用文件列表时，省略 `file_path`，传空字符串或仅由空格/tab 组成的字符串，或精确传入 `SKILL.md`：

```json
{
  "skill_id": "builtin/skill-authoring",
  "file_path": "SKILL.md"
}
```

根读取会返回根正文和扁平的 `Skill files` 列表。代码块中的每一行都是可直接复制到后续 `file_path` 的完整相对路径：

```json
{
  "skill_id": "builtin/skill-authoring",
  "file_path": "reference.md"
}
```

不要传目录、绝对路径、`./`、`..`、反斜杠，或对路径添加首尾空白。辅助文件由 Worker 的通用文本读取器规范化后返回；它们不是字节或换行保真读取。

## 编写建议

- 一个 skill 聚焦一个明确目标，正文先写结论和最小可执行步骤。
- 把较长参考内容、示例和清单放入平级辅助文件，让根说明只保留导航和关键约束。
- 在根说明中准确引用文件路径；路径应能直接复制到 `file_path` 参数。
- 目录名应稳定、短且语义清晰，例如 `plugin-development`、`skill-authoring`。
- 不要放入二进制、密钥、token、隐私数据或高度临时的信息。

## 评审清单

- 顶层目录是否有直属、常规文件类型的 `SKILL.md`？
- 是否优先采用平级多文件，而不是不必要地增加层级？
- 根说明是否包含目标读者、最小步骤和可复制示例？
- 每个辅助文件路径是否是规范相对路径，并适合直接填入 `file_path`？
- 名称和描述是否仅作为展示元数据，而非定位或授权依据？
- 内容是否与当前加载协议、工具 schema 和实际行为一致？
