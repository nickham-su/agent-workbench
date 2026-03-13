# debug-tools

最小本地工具插件样板，用于验证 `agent-workbench` 插件系统 Phase 1~5。

工具：

- `plugin_debug-tools_echo_inspect`

主要分支：

- `mode = "ok"`
- `mode = "throw"`
- `mode = "long_text"`

该目录默认作为仓库内 fixture/示例存在；实际运行时可复制到 `<dataDir>/plugins/debug-tools/` 供 API 扫描与 worker 加载。
