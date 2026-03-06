# Agent Providers 设置页左右布局重构(v1)

本文档描述 Web 前端 **Settings → Agent → Providers** 页面(Provider 设置页)的交互与布局重构方案。

范围强调: **仅改前端交互与布局**，不修改后端 API、不变更 settings 数据结构。

## 背景

当前 Provider 设置页在同一列中展示 Provider 列表，并在每个 Provider 条目内用 tag 预览模型；模型的增删改查主要通过“管理模型”的弹窗完成。

随着 Provider/Model 数量增加，用户需要频繁在多个 Provider 的模型之间切换与对比。将页面改为左右布局可以降低滚动成本，并让模型列表成为稳定的主操作区域。

## 目标

- 左右布局:
  - 左侧为 **Provider 列表(导航/选择)**
  - 右侧为 **选中 Provider 的模型列表(只展示关键信息 + 常用快捷操作)**
- 模型 **新建/编辑** 仍通过弹窗完成(保持现有表单校验与报错路径)。
- 模型列表内提供快捷操作:
  - 复制(copy)
  - 删除(delete)
  - 设为默认(set default)
- 模型列表排序规则:
  - **默认模型置顶**
  - 其余模型按 **name 升序** 排序
- 不做 URL query 同步 providerId。
- 不处理窄屏响应式: 始终左右布局。

## 非目标

- 不新增/修改 API: 仍使用 `GET/PUT /api/settings/agent/providers`。
- 不改变自动保存语义(现状为多数操作后自动持久化)。
- 不引入新的“批量保存/撤销”工作流。
- 不新增 Provider/Model 的新字段或新的校验规则。

## 现状实现位置(参考)

- Settings 页面入口:
  - `apps/web/src/features/settings/views/SettingsTab.vue`
- Provider 设置页组件:
  - `apps/web/src/features/settings/components/AgentProvidersSettingsPanel.vue`
- API 封装:
  - `apps/web/src/shared/api/api.ts` 中的 `getAgentProvidersSettings()` / `updateAgentProvidersSettings()`

当前组件内既包含 Provider 列表，也包含模型管理弹窗(model manager modal)与模型编辑弹窗(model editor modal)。本方案中，“模型管理弹窗”的列表内容将改为右侧常驻区域；模型编辑弹窗继续保留。

## 新布局

整体采用 flex 左右分栏，建议两列各自独立滚动。

### 左侧: Provider 列表(不展示模型)

展示内容(每行):

- `provider.name` (主标题)
- `provider.id` (次要信息)
- 可选 tag:
  - `default`：当该 provider 命中当前全局默认模型(`selectedDefault.providerId === provider.id`)
  - `npm`：展示 provider 使用的 npm adapter

交互:

- 点击整行: 选中 Provider，刷新右侧模型列表
- 行尾操作:
  - 编辑 Provider(弹窗)
  - 删除 Provider(confirm)
- 顶部操作:
  - 新增 Provider(弹窗)

约束:

- **不在 Provider 列表中展示模型 tag/模型预览**(避免左右区域信息重复)。

### 右侧: 模型列表(选中 Provider)

右侧分为“标题栏 + 列表”。

标题栏建议包含:

- 当前 Provider 信息(帮助用户确认上下文): `provider.name` / `provider.id` / `provider.npm`
- 操作按钮:
  - `Add model`：打开“新建模型”弹窗
- 保存状态提示:
  - `saving...` 文案沿用现有 `saving` 状态

模型列表每行展示(重要信息):

- `model.name`
- `model.id`
- `model.contextWindowTokens` (tokens 上限)
- 建议同时展示 `model.providerModelId`(用于排查真实请求模型 id)
- `default` tag(当该模型为全局默认模型)

模型列表每行操作:

- `Set default`：仅当非默认模型时显示
- `Edit`：打开“编辑模型”弹窗
- `Copy`：复制模型并持久化
- `Delete`：确认删除并持久化

空态:

- 未选中 Provider: 右侧提示“从左侧选择 Provider”
- 选中 Provider 但无模型: 右侧提示“暂无模型”，提供 `Add model`

## 交互细则

### Provider 的选中与默认选中

新增本地状态 `activeProviderId` 用于驱动右侧展示。

推荐默认选中策略(页面加载完成后):

1) 若存在全局默认模型引用(`selectedDefault.providerId`)且该 provider 存在: 选中该 provider
2) 否则选中 `providers[0]`
3) 若 providers 为空: `activeProviderId = ""`

### 模型列表排序

对右侧展示的模型列表进行排序(仅影响 UI 展示，不改变存储顺序):

1) 默认模型置顶
2) 其余按 `model.name` 升序排序(建议使用 localeCompare，忽略大小写)

> 注意: 仅排序右侧的渲染数组，不直接重排 `provider.models` 源数据，以避免“用户未做排序操作但保存后顺序变化”的意外。

### 新建/编辑模型(弹窗)

- 新建模型:
  - 入口: 右侧 `Add model`
  - 行为: 触发既有 `openAddModel(activeProviderId)`，使用既有 model editor modal
- 编辑模型:
  - 入口: 模型行内 `Edit`
  - 行为: 触发既有 `openEditModel(activeProviderId, model.id)`

错误/校验:

- 与现有一致: 由用户点击弹窗 `OK` 时触发校验、JSON 解析与错误提示(`message.error(...)`)。

### 列表内快捷操作

- `Set default`:
  - 点击即更新 `selectedDefault` 并触发持久化
  - 成功后提示 toast(沿用现状)
- `Copy`:
  - 点击即复制一条模型配置并触发持久化
  - 复制后的新模型 id 使用本地生成规则(沿用现状)
- `Delete`:
  - 二次确认(Modal.confirm)
  - 确认后删除并触发持久化
  - 若删除的是默认模型，需要清空默认选择(沿用现状)

### 删除 Provider 的联动

删除 Provider 后:

- 若删除的是当前选中 provider:
  - 自动切换到下一个可用 provider(或上一个)
  - 若已无 provider: 右侧进入“未选中 provider”空态
- 若默认模型属于被删 provider:
  - 清空默认模型引用(沿用现状的 sanitize/sync 逻辑)

## 保存与错误处理

沿用现有策略:

- 多数操作后会触发 `persist({ toast: true })`
- `persist` 失败:
  - `message.error(...)`
  - **保留本地改动**，后续用户操作会再次触发 `persist`
- 若保存正在进行:
  - 使用 `pendingSave` 合并后续保存请求(避免并发 PUT)

## 实现提示(非代码)

为尽量最小改动，建议:

- 保留现有 provider editor modal 与 model editor modal
- 移除或弃用“模型管理器弹窗(model manager modal)”的打开入口，将其列表 UI 移到右侧常驻
- 新增/维护 `activeProviderId`，并基于它计算:
  - `activeProvider`
  - `sortedModelsForActiveProvider`
- UI 仅排序展示数组，不强制重排数据源

## 手工验证清单

- 加载:
  - providers 为空/非空时空态与默认选中正确
  - loading/saving 文案与现状一致
- Provider 切换:
  - 切换后右侧刷新正确，无额外保存请求
- 模型操作:
  - Add/Edit 走弹窗，错误提示只在 OK 时出现
  - Copy/Delete/Set default 在列表内可用，成功/失败提示符合现状
  - 默认模型置顶排序正确，其他按 name 排序
- 删除 Provider:
  - 删除当前选中 provider 后，active provider 切换正确
  - 删除包含默认模型的 provider 后，默认引用被清理

