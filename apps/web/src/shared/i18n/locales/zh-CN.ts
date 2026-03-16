export default {
  app: {
    title: "AgentWorkbench"
  },
  common: {
    add: "新增",
    create: "新建",
    edit: "编辑",
    delete: "删除",
    save: "保存",
    cancel: "取消",
    refresh: "刷新",
    loading: "加载中...",
    reset: "重置",
    default: "默认",
    yes: "是",
    no: "否",
    format: {
      parens: "（{text}）",
      parensSuffix: "（{text}）"
    }
  },
  gitIdentity: {
    modalTitle: "设置 Git 身份",
    form: {
      nameLabel: "姓名",
      namePlaceholder: "例如 Your Name",
      emailLabel: "邮箱",
      emailPlaceholder: "例如 name{at}example.com",
      scopeLabel: "作用范围"
    },
    scope: {
      session: "仅本次提交",
      repo: "仅当前仓库",
      global: "全局"
    },
    actions: {
      saveAndContinue: "保存并继续",
      cancel: "取消"
    }
  },
  auth: {
    login: {
      title: "访问登录",
      tokenLabel: "Token",
      tokenPlaceholder: "请输入访问 token",
      remember30d: "记住 30 天",
      submit: "登录",
      hint: "提示：未勾选时仅本次浏览器会话有效。"
    }
  },
  workbench: {
    tabs: {
      workspaces: "工作区",
      repos: "仓库",
      settings: "设置"
    }
  },
  repos: {
    emptyGuide: {
      title: "添加第一个仓库",
      lead: "添加 Git URL 后, 工作台会为仓库维护本地镜像(mirror), 用于更快地创建工作区和获取分支信息",
      autoSync: "通常不需要手动同步, 创建工作区时会自动同步到最新",
      incremental: "同步是增量的, 一般明显快于每次从远端全量拉取",
      supportPrefix: "支持在设置中配置",
      supportAnd: "和",
      supportSuffix: ""
    },
    search: {
      placeholder: "搜索仓库（URL）",
      empty: "无匹配仓库"
    },
    actions: {
      add: "添加仓库",
      sync: "同步",
      edit: "修改",
      delete: "删除"
    },
    create: {
      modalTitle: "添加仓库",
      gitUrlLabel: "Git URL",
      gitUrlPlaceholder: "https://github.com/org/repo.git 或 git{at}github.com:org/repo.git",
      credentialLabel: "凭证（可选）",
      credentialPlaceholder: "选择凭证（私有仓库推荐选择）",
      credentialHelpPrefix: "私有仓库访问失败？去设置配置：",
      credentialHelpSuffix: "",
      credentialHostMismatch: "URL host 为 {urlHost}，所选凭证 host 为 {credHost}，请改选匹配 host 的凭证。",
      credentialKindMismatch: "URL 协议为 {urlKind}，所选凭证类型为 {credKind}，请切换 URL 或选择匹配的凭证。"
    },
    edit: {
      modalTitle: "修改仓库",
      credentialLabel: "凭证（可选）",
      credentialPlaceholder: "选择凭证（私有仓库推荐选择）",
      credentialHelp: "修改后可重新同步以验证。",
      credentialHostMismatch: "URL host 为 {urlHost}，所选凭证 host 为 {credHost}，请改选匹配 host 的凭证。",
      credentialKindMismatch: "URL 协议为 {urlKind}，所选凭证类型为 {credKind}，请切换 URL 或选择匹配的凭证。",
      updated: "仓库已更新"
    },
    deleteConfirm: {
      title: "确认删除仓库？",
      content: "删除将同时删除镜像（mirror）目录；若存在工作区引用则会失败。",
      ok: "删除",
      cancel: "取消"
    },
    sync: {
      started: "已开始同步",
      alreadySyncing: "同步进行中",
      success: "同步完成",
      failed: "仓库同步失败",
      timeout: "仓库同步超时，请稍后重试"
    },
    syncStatus: {
      syncing: "同步中",
      failed: "失败"
    }
  },
  workspaces: {
    emptyGuide: {
      title: "创建第一个工作区",
      lead: "工作区是由单一/多个仓库组成的开发目录, 并为AI Agent提供远程运行环境。",
      flowPrefix: "典型使用流程:",
      flowCredNetPrefix: "在设置配置",
      flowRepoCredential: "仓库凭证",
      flowCredNetAnd: "和",
      flowCredNetSuffix: "(CA证书/代理)",
      flowAddPrefix: "添加",
      flowCreate: "创建工作区并进入, 打开终端, 安装AI Agent CLI工具并使用"
    },
    search: {
      placeholder: "搜索工作区（标题/仓库）",
      empty: "无匹配工作区"
    },
    actions: {
      create: "创建工作区",
      rename: "编辑",
      delete: "删除",
      attachRepo: "添加仓库",
      detachRepo: "移除仓库"
    },
    tooltip: {
      activeTerminals: "有 {n} 个活跃终端，点击关闭"
    },
    create: {
      modalTitle: "创建工作区",
      repoLabel: "仓库",
      repoPlaceholder: "选择仓库",
      titleLabel: "标题",
      titlePlaceholder: "可选：默认使用仓库名拼接",
      terminalCredentialLabel: "终端凭证",
      terminalCredentialHelp: "将凭证应用到终端",
      terminalCredentialDisabledWarning: "在终端里使用git命令连接 remote 可能失败，或需手动配置",
      terminalCredentialUnavailable:
        "所选仓库凭证不一致，终端无法自动应用；需在终端自行配置git连接remote。",
      defaultBranchUnknown: "无法确定默认分支，请先同步仓库"
    },
    rename: {
      modalTitle: "编辑工作区",
      titleLabel: "标题",
      titlePlaceholder: "输入新的工作区标题",
      terminalCredentialAffectsNewOnly: "仅影响之后新创建的终端；已存在终端需关闭后重新打开才会生效"
    },
    deleteConfirm: {
      title: "确认删除工作区？",
      content: "会关闭该工作区下所有终端，并删除工作区目录。",
      ok: "删除",
      cancel: "取消"
    },
    closeTerminalsConfirm: {
      title: "关闭所有终端？",
      content: "将关闭该工作区下所有活跃终端。",
      ok: "关闭",
      cancel: "取消",
      partialFailed: "部分终端关闭失败：{failed} 个"
    }
  },
  workspace: {
    title: "工作区",
    actions: {
      checkout: "切换分支",
      pull: "拉取",
      push: "推送",
      attachRepo: "添加仓库",
      detachRepo: "移除仓库"
    },
    repoSelector: {
      placeholder: "选择仓库",
      detached: "Detached HEAD"
    },
    attachRepo: {
      modalTitle: "添加仓库",
      ok: "添加",
      cancel: "取消",
      repoLabel: "仓库",
      repoPlaceholder: "选择仓库",
      empty: "暂无可添加的仓库",
      success: "仓库已添加",
      downgraded: "因凭证不兼容,已自动关闭终端凭证",
      errors: {
        alreadyExists: "仓库已在当前工作区中",
        dirConflict: "仓库目录冲突,请重试",
        prepareFailed: "仓库准备失败,请检查凭证或网络",
        defaultBranchUnknown: "无法确定默认分支,请先同步仓库",
        branchNotFound: "目标分支不存在"
      }
    },
    detachRepo: {
      confirmTitle: "移除仓库？",
      confirmContent: "将从当前工作区移除该仓库目录,不会影响全局仓库列表。",
      ok: "移除",
      cancel: "取消",
      success: "仓库已移除",
      disabledNoRepo: "当前未选择仓库",
      disabledActiveTerminals: "存在 {n} 个活跃终端,请先关闭",
      disabledBusy: "当前有操作进行中,请稍后再试",
      errors: {
        activeTerminals: "存在活跃终端,无法移除",
        notFound: "该仓库已不存在"
      }
    },
    tools: {
      codeReview: "代码审查",
      terminal: "终端",
      files: "文件",
      search: "搜索",
      agent: "AI Agent",
      editor: "编辑器"
    },
    dock: {
      moveTo: "移动到 {area}",
      moveUp: "上移",
      moveDown: "下移",
      pinnedAt: "已固定在 {area}",
      areas: {
        leftTop: "左上",
        leftBottom: "下方",
        rightTop: "右上"
      },
      splitter: {
        resizeTopLeftRight: "调整上方左右视图大小",
        resizeTopBottom: "调整上下视图大小"
      }
    },
    splitter: {
      resizeTerminalPanel: "调整终端面板大小"
    },
    checkout: {
      modalTitle: "切换分支",
      ok: "切换",
      cancel: "取消",
      targetBranch: "目标分支",
      branchPlaceholder: "选择分支",
      refreshBranches: "刷新分支列表",
      tip: "说明：存在未提交变更时切分支可能失败或产生冲突，复杂情况建议在终端处理。",
      confirmTitle: "确认切换分支？",
      confirmContent: "检测到存在未提交变更，切分支可能失败或产生冲突。",
      switchedTo: "已切换到 {branch}"
    },
    pull: {
      confirmTitle: "确认拉取？",
      confirmContent: "检测到存在未提交变更，pull 可能失败或产生冲突，复杂情况建议在终端处理。",
      okContinue: "继续拉取",
      cancel: "取消",
      updated: "已拉取最新提交",
      upToDate: "已是最新"
    },
    push: {
      pushedTo: "已推送到 {remote}/{branch}",
      noUpstreamTitle: "未设置上游分支（upstream）",
      noUpstreamContent: "是否设置上游分支（upstream）后重试推送？",
      okSetUpstreamAndPush: "设置并推送",
      cancel: "取消",
      nonFastForwardTitle: "推送被拒绝（非快进）",
      nonFastForwardContent: "是否使用 force-with-lease（更安全的强推）重试推送？",
      okForceWithLease: "强制推送重试"
    }
  },
  agent: {
    empty: "暂无会话,请新建一个 AI client",
    closedEmpty: "当前 client 已全部关闭",
    actions: {
      newClient: "新建 client",
      creating: "创建中...",
      refresh: "刷新",
      minimize: "最小化",
      closeClient: "关闭会话",
      reopenClosed: "恢复已关闭 client"
    },
    client: {
      tabLabel: "会话 {index}",
      newTitle: "new session",
      cancel: "取消运行",
      cancelConfirmTitle: "确认取消当前运行？",
      cancelConfirmContent: "将中断当前执行,并保留当前会话消息。当前正在执行的 AI 或工具会标记为已取消。",
      cancelled: "已取消当前运行",
      welcome: "你好, 我可以协助你完成任务。",
      reachedTop: "已到最早",
      contextBoundary: "上下文边界",
      inputPlaceholderIdle: "输入消息,Enter 发送,Shift+Enter 换行,Tab 切换 Agent",
      inputPlaceholderRunning: "运行中,Esc 取消当前运行",
      inputPlaceholderNoAgent: "当前没有可用于用户会话的 Agent,请前往设置页调整范围或新增 Agent",
      noAgentHint: "当前没有可用于用户会话的 Agent,请前往设置页调整范围或新增 Agent",
      goCreateAgent: "前往创建",
      chooseSession: "选择会话",
      chooseSessionTitle: "选择要继续的会话",
      noSessionToChoose: "没有可选择的历史会话",
      sessionEmptyPreview: "(该会话暂无用户消息)",
      runNoticeLabel: "运行通知",
      runNoticeEmpty: "当前没有运行时通知",
      lastTotalTokens: "总Token",
      backToParent: "返回",
      copySessionId: "复制 Session ID",
      sessionIdCopied: "已复制 Session ID",
      parentSessionMissing: "未找到父会话",
      subtaskRunningHint: "已运行 {elapsed}，如需取消请到主会话",
      subtaskCancelInParentHint: "如需取消，请到主会话",
      subtaskCardTitle: "子任务",
      subtaskMode: "模式",
      subtaskModeNew: "新会话",
      subtaskModeFork: "继承上下文",
      subtaskModeExisting: "续用会话",
      subtaskAgent: "Agent",
      subtaskSessionId: "Session ID",
      todoListCardTitle: "任务清单",
      todoListSummary: "总计 {total}, 进行中 {inProgress}, 待办 {pending}, 已完成 {completed}, 已取消 {cancelled}",
      todoListGoal: "目标",
      todoListEmpty: "当前清单为空",
      applyPatchCardTitle: "补丁变更",
      applyPatchPreview: "补丁预览",
      applyPatchApplied: "已应用",
      applyPatchFileCount: "文件",
      applyPatchLineStats: "行变更",
      applyPatchFrom: "来源",
      applyPatchNoFiles: "无可展示的文件差异",
      applyPatchOmittedFiles: "还有 {count} 个文件未展示",
      fork: "从此处分叉",
      forked: "已从该消息创建新 client",
      revert: "回退到此处",
      revertTargetMissing: "未找到可回退的上一条事件",
      revertConfirmTitle: "确认回退到这条消息？",
      revertConfirmContent: "将回退到该消息之前,并把该条消息填入输入框。回退后,后续对话分支将暂时不可见。",
      revertConfirmTitleAssistant: "确认回退到这条 AI 消息？",
      revertConfirmContentAssistant: "将回退到该条 AI 消息并保留该消息。回退后,后续对话分支将暂时不可见。",
      reverted: "已回退到选中消息",
      roles: {
        user: "我",
        assistant: "AI",
        tool: "工具",
        system: "系统"
      },
      compactionArchivedHint: "更早的内容已归档",
      slashCommandHintTitle: "特殊指令",
      slashCommandHintStrictOnly: "精确匹配",
      externalSkillRootsTitle: "External Skill Roots",
      externalSkillRootsHint: "选择要启用的外部 skill 根目录。保存后仅对后续新运行生效，当前运行不会刷新。",
      externalSkillRootsEmpty: "未探测到候选 skills 目录",
      externalSkillRootsSaved: "已保存外部 skill roots 配置",
      externalSkillRootsSourceWorkspace: "Workspace",
      externalSkillRootsSourceRepo: "Repo",
      externalSkillRootsMeta: "{source} · {count} 个顶级 skills",
      slashCommandHintNoMatch: "未找到匹配的指令: /{query}",
      slashCommands: {
        compact: {
          summary: "手动压缩当前会话上下文"
        },
        clear: {
          summary: "开始新任务并归档当前可见上下文"
        }
      }
    }
  },
  codeReview: {
    placeholder: {
      title: "代码审查（占位）",
      desc: "在这里查看当前仓库的变更、暂存与差异。",
      selectRepo: "请先选择一个仓库"
    },
    unstaged: "未暂存",
    staged: "已暂存",
    actions: {
      stageAll: "全部暂存",
      discardAll: "全部丢弃",
      refresh: "刷新",
      stage: "暂存",
      unstageAll: "全部取消暂存",
      unstage: "取消暂存",
      commit: "提交",
      commitEllipsis: "提交…",
      commitAndPush: "提交并推送",
      cancel: "取消"
    },
    status: {
      noChanges: "无变更"
    },
    file: {
      oldPath: "原：{oldPath}"
    },
    discard: {
      deleteUntracked: "删除未跟踪文件",
      discardChanges: "丢弃变更",
      confirmDeleteTitle: "确认删除？",
      confirmDiscardTitle: "确认丢弃？",
      okDelete: "删除",
      okDiscard: "丢弃",
      cancel: "取消",
      deleted: "已删除未跟踪文件",
      discarded: "已丢弃变更",
      confirmAllTitle: "确认全部丢弃？",
      confirmAllContent: "将丢弃所有未暂存变更，并删除未跟踪文件（不会删除 .gitignore 忽略项）。",
      okDiscardAll: "全部丢弃",
      discardedAll: "已全部丢弃",
      preview: {
        untracked: "将删除未跟踪文件：{path}",
        rename: "将撤销重命名：{oldPath} → {path}",
        changes: "将丢弃该文件的未暂存变更：{path}"
      }
    },
    diff: {
      resizeFileList: "调整文件列表宽度",
      prevChange: "上一处差异",
      nextChange: "下一处差异",
      viewFile: "查看文件",
      inline: "单列",
      sideBySide: "双列",
      selectToCompare: "选择左侧文件以查看对比",
      notPreviewableTitle: "该文件暂不支持预览",
      baseReason: "旧文件：{reason}",
      currentReason: "新文件：{reason}",
      loading: "加载中…"
    },
    commit: {
      modalTitle: "提交",
      messageLabel: "提交信息",
      messagePlaceholder: "请输入提交信息",
      summary: "将提交：{count} 个文件",
      committed: "已提交 {sha}"
    },
    preview: {
      previewable: "可预览",
      tooLarge: "文件过大{bytesSuffix}",
      binary: "二进制文件{bytesSuffix}",
      decodeFailed: "无法解码为 UTF-8{bytesSuffix}",
      unsafePath: "不安全路径{bytesSuffix}",
      notPreviewable: "不可预览{bytesSuffix}"
    }
  },
  terminal: {
    panel: {
      collapse: "折叠终端面板"
    },
    empty: {
      title: "还没有终端，点击打开终端",
      create: "打开终端",
      creating: "创建中…"
    },
    tab: {
      name: "终端 {index}",
      close: "关闭终端"
    },
    layout: {
      moveRight: "移到右边",
      moveBottom: "移到底部"
    },
    confirmClose: {
      title: "确认关闭终端？",
      content: "将终止对应的 tmux 会话。",
      ok: "关闭",
      cancel: "取消"
    },
    occupied: {
      status: "连接被占用（已在其他页面/设备连接）",
      takeover: "接管连接"
    },
    takeover: {
      title: "接管连接？",
      content: "接管会踢掉该终端在其他页面/设备上的连接。",
      ok: "接管",
      cancel: "取消"
    },
    copyFailed: "复制失败：{reason}",
    hint: {
      autoReconnectFailedLine0: "[自动重连失败] 已连续重试 {attempts} 次仍无法连接。",
      autoReconnectFailedLine1: "服务端暂时不可用或网络不稳定；稍后会再次自动尝试。",
      autoReconnectFailedLine2: "若你怀疑该终端已在其他页面/设备连接，可刷新页面查看是否提示“连接被占用”。",
      autoReconnecting: "[自动重连中] 第 {attempt} 次尝试，{seconds}s 后重连…",
      connectFailedLine0: "[连接失败] 无法创建 WebSocket 连接。",
      connectFailedLine1: "可尝试刷新页面或稍后重试。",
      blockedLine0: "[连接被占用] 该终端已在其他页面/设备连接。",
      blockedLine1: "详情：code={code} reason={reason} wasClean={wasClean}",
      blockedLine2: "可点击“接管连接”尝试强制接管（会踢掉旧连接）。",
      unauthorizedLine0: "[未授权] 当前会话已失效，请重新登录。",
      unauthorizedLine1: "详情：code={code} reason={reason} wasClean={wasClean}",
      disconnectedLine0: "[连接已断开] 连接已断开，将自动尝试重连。",
      disconnectedLine1: "详情：code={code} reason={reason} wasClean={wasClean}",
      disconnectedLine2: "若提示被占用，可点击“接管连接”。",
      closed: "[连接已关闭，exitCode={exitCode}]",
      error: "[错误] {message}"
    }
  },
  files: {
    title: "文件",
    actions: {
      newFile: "新建文件",
      newFolder: "新建文件夹",
      upload: "上传",
      copyName: "复制名称",
      copyPath: "复制仓库内路径",
      copyRepoPath: "复制仓库内路径",
      copyWorkspacePath: "复制工作区路径",
      download: "下载",
      rename: "重命名",
      delete: "删除",
      refresh: "刷新",
      close: "关闭",
      closeOthers: "关闭其他",
      closeAll: "关闭所有"
    },
    copy: {
      nameCopied: "已复制名称",
      pathCopied: "已复制路径",
      repoPathCopied: "已复制仓库内路径",
      workspacePathCopied: "已复制工作区路径",
      failed: "复制失败"
    },
    upload: {
      uploading: "正在上传…",
      success: "上传完成",
      partialFailed: "以下文件上传失败: {names}"
    },
    status: {
      saving: "正在保存…"
    },
    resizeFileList: "调整文件列表宽度",
    placeholder: {
      selectRepo: "请选择仓库",
      openFile: "从左侧选择文件打开",
      empty: "暂无文件"
    },
    form: {
      nameLabel: "名称",
      namePlaceholder: "输入名称",
      renamePlaceholder: "输入新名称",
      nameRequired: "请输入名称",
      nameInvalid: "名称不能包含 / 或 \\"
    },
    createFile: {
      title: "新建文件"
    },
    createFolder: {
      title: "新建文件夹"
    },
    rename: {
      title: "重命名"
    },
    deleteConfirm: {
      title: "确认删除？",
      content: "将删除所选文件或文件夹",
      loadedHint: "已加载子项: {count}",
      ok: "删除",
      cancel: "取消"
    },
    closeConfirm: {
      title: "关闭未保存的文件？",
      content: "该文件有未保存修改，确认关闭？",
      ok: "关闭",
      cancel: "取消"
    },
    closeOthersConfirm: {
      title: "关闭其他标签页？",
      content: "其他标签页中有 {count} 个未保存文件，确认关闭其他标签页？",
      ok: "关闭其他",
      cancel: "取消"
    },
    closeAllConfirm: {
      title: "关闭全部标签页？",
      content: "当前有 {count} 个未保存文件，确认关闭全部标签页？",
      ok: "关闭全部",
      cancel: "取消"
    },
    conflict: {
      title: "保存冲突",
      content: "文件已被外部修改，请选择操作",
      reload: "重新加载",
      force: "强制覆盖"
    },
    preview: {
      tooLarge: "文件过大，暂不支持预览",
      binary: "二进制文件，暂不支持预览",
      decodeFailed: "文件无法解码，暂不支持预览",
      unsafePath: "路径不安全，无法预览",
      missing: "文件不存在",
      unavailable: "无法预览"
    }
  },
  search: {
    placeholder: {
      selectRepo: "请选择仓库",
      query: "输入搜索内容(按回车键搜索)",
      queryEmpty: "请输入搜索内容"
    },
    scope: {
      global: "全局",
      repos: "指定仓库",
      reposPlaceholder: "选择仓库(可多选)"
    },
    options: {
      regex: "正则表达式",
      caseSensitive: "区分大小写",
      wholeWord: "整词"
    },
    actions: {
      search: "搜索",
      viewFile: "查看文件"
    },
    status: {
      idle: "请输入搜索内容后搜索",
      searching: "搜索中…",
      error: "搜索失败",
      empty: "暂无结果",
      results: "共 {count} 条结果 · {tookMs}ms",
      truncated: "结果已截断",
      timedOut: "搜索超时"
    },
    hint: {
      ignore: "遵循.gitignore/.ignore",
      hidden: "已包含隐藏文件"
    },
    preview: {
      empty: "暂无预览"
    }
  },
  settings: {
    title: "设置",
    tabs: {
      general: "常规",
      search: "搜索",
      gitIdentity: "Git 身份",
      credentials: "凭证",
      network: "网络",
      agentProviders: "模型提供方",
      agentGlobalPrompts: "提示词库",
      agentMcp: "MCP",
      agentProfiles: "角色配置",
      agentPlugins: "插件",
      agentRuntime: "运行参数",
      agentChannelSenderAllowlist: "IM用户列表",
      security: "安全"
    },
    groups: {
      basic: "基础",
      identity: "身份与凭证",
      networkSecurity: "网络与安全",
      agent: "Agent"
    },
    general: {
      language: {
        label: "语言",
        help: "切换界面语言（立即生效，并保存到本地）。",
        options: {
          "zh-CN": "简体中文",
          "en-US": "English"
        },
        changed: "已切换语言"
      },
      fontSize: {
        terminal: {
          label: "终端字号",
          help: "调整终端字体大小（全局生效，自动保存到本地）。默认：{default}"
        },
        editor: {
          label: "编辑器字号",
          help: "调整编辑器字号（包含 Diff 视图，全局生效，自动保存到本地）。默认：{default}"
        },
        agent: {
          label: "AI Agent字号",
          help: "调整 AI Agent 会话字号（消息与输入框，全局生效，自动保存到本地）。默认：{default}"
        }
      }
    },
    search: {
      description: "配置搜索时默认忽略的文件或目录（每行一个 glob）。",
      excludeGlobs: {
        label: "忽略规则",
        help: "示例: node_modules/**, dist/**, .venv/**",
        ignoreHint: "搜索默认遵循 .gitignore/.ignore,且始终忽略 .git/**"
      },
      actions: {
        save: "保存",
        refresh: "刷新"
      },
      saved: "已保存"
    },
    gitIdentity: {
      description: "配置全局 Git 提交身份（user.name / user.email）。",
      form: {
        nameLabel: "全局 user.name",
        namePlaceholder: "例如 Your Name",
        emailLabel: "全局 user.email",
        emailPlaceholder: "例如 name{at}example.com"
      },
      actions: {
        save: "保存",
        refresh: "刷新",
        clearAll: "清除全部身份"
      },
      saved: "已保存",
      cleared: "已清除",
      clearedWithErrors: "已清除（{count} 个工作区清理失败）",
      clearAllConfirm: {
        title: "确认清除全部身份？",
        content: "将清除全局配置，并遍历所有工作区仓库清除本地 user.name/user.email。",
        ok: "清除",
        cancel: "取消"
      }
    },
    credentials: {
      description: "管理 Git 凭证（HTTPS Token / SSH Key），可按 host 复用并设置默认凭证。",
      empty: "暂无凭证",
      copied: "已复制",
      copyFailed: "复制失败，请手动选择并复制",
      tags: {
        default: "默认"
      },
      actions: {
        add: "新增凭证",
        edit: "编辑",
        delete: "删除",
        generateSshKey: "生成密钥",
        copyPublicKey: "复制公钥"
      },
      modal: {
        createTitle: "新增凭证",
        editTitle: "编辑凭证",
        ok: "保存",
        cancel: "取消"
      },
      form: {
        hostLabel: "Host",
        hostPlaceholder: "例如 github.com 或 git.company.com",
        kindLabel: "类型",
        kindHttps: "HTTPS",
        kindSsh: "SSH",
        labelLabel: "名称（可选）",
        labelPlaceholder: "例如 GitHub Personal / 公司 GitLab",
        usernameLabel: "用户名（可选）",
        usernamePlaceholderHttps: "部分自建 Git 服务可能需要",
        usernamePlaceholderSsh: "通常为 git",
        secretPlaceholder: "不会回显已保存的 secret",
        generateSshHelp: "生成后将自动填入私钥，并展示公钥供复制到 Git 平台。",
        publicKeyLabel: "SSH 公钥",
        publicKeyHelp: "将公钥添加到账号 SSH key 或仓库 Deploy key。",
        isDefault: "设为该 host 默认凭证",
        secretLabel: {
          httpsCreate: "Token",
          httpsEdit: "Token（留空则不修改）",
          sshCreate: "SSH 私钥（无口令）",
          sshEdit: "SSH 私钥（留空则不修改）"
        }
      },
      tip: "提示：SSH 暂不支持带口令（passphrase）的私钥；首次连接主机会自动记录指纹，若主机指纹变化需在 安全 中重置信任。",
      deleteConfirm: {
        title: "确认删除凭证？",
        content: "若存在仓库引用将会失败。",
        ok: "删除",
        cancel: "取消"
      }
    },
    network: {
      description: "配置代理与企业 CA 证书（用于访问自建 Git 服务）。",
      form: {
        httpProxyLabel: "HTTP_PROXY",
        httpsProxyLabel: "HTTPS_PROXY",
        noProxyLabel: "NO_PROXY",
        httpProxyPlaceholder: "例如 http://127.0.0.1:7890",
        httpsProxyPlaceholder: "例如 http://127.0.0.1:7890",
        noProxyPlaceholder: "例如 localhost,127.0.0.1,.company.com",
        caCertLabel: "企业 CA 证书（PEM，可选）",
        caCertPlaceholder: "粘贴 PEM 内容，支持多个 PEM 块",
        applyToTerminalLabel: "应用到终端",
        applyToTerminalEffect: "作用：将代理/证书注入新建终端环境；仅配置凭证，终端里可能仍无法访问内网 Git（还需代理或 CA 证书）。",
        applyToTerminalRisk: "风险：若代理地址包含账号密码，可能在终端环境变量/进程信息中泄露。"
      },
      actions: {
        save: "保存",
        refresh: "刷新"
      },
      saved: "已保存"
    },
    agentProviders: {
      description: "管理 AI Provider 与模型。可新增/编辑 Provider，并在 Provider 下管理模型与默认模型。",
      saving: "正在保存...",
      empty: "暂无 Provider，请先新增",
      selectProviderHint: "请从左侧选择一个 Provider 查看模型",
      actions: {
        save: "保存",
        refresh: "刷新",
        addProvider: "新增 Provider",
        manageModels: "管理模型",
        addModel: "添加模型",
        copy: "复制",
        edit: "编辑",
        delete: "删除",
        setDefault: "设为默认"
      },
      fields: {
        baseURL: "Base URL",
        providerOptionsKey: "Provider Options Key",
        apiKey: "API Key",
        apiKeyNotSet: "未设置",
        apiKeySet: "已更新",
        apiKeyKeep: "保持不变",
        models: "模型",
        noModels: "暂无模型"
      },
      modal: {
        ok: "确定",
        cancel: "取消"
      },
      providerModal: {
        createTitle: "新增 Provider",
        editTitle: "编辑 Provider"
      },
      providerForm: {
        idLabel: "Provider ID(自动生成)",
        nameLabel: "名称",
        npmLabel: "Provider 类型",
        baseUrlLabel: "Base URL",
        apiKeyLabel: "API Key",
        apiModeLabel: "API 模式",
        apiKeyPlaceholder: "输入 API Key（可留空）",
        apiKeyEditPlaceholder: "输入新 API Key（留空保持不变）",
        apiKeyCreateHelp: "创建时可先留空，后续再补充。",
        apiKeyEditHelp: "编辑时留空表示保持已有值不变。",
        clearApiKey: "清空当前 API Key"
      },
      modelModal: {
        createTitle: "添加模型",
        editTitle: "编辑模型",
        delete: "删除模型"
      },
      modelManager: {
        title: "管理模型 - {name}",
        empty: "暂无模型"
      },
      modelForm: {
        idLabel: "Model 内部ID",
        idHelp: "支持从候选列表选择, 也支持手动输入任意 Model ID。",
        renameGuardLabel: "改名引用检查",
        providerModelIdLabel: "Provider 模型ID",
        nameLabel: "显示名称",
        contextWindowTokensLabel: "上下文窗口 Token 上限",
        contextWindowTokensHelp: "该模型的上下文窗口上限,用于自动压缩阈值计算基数。必须为正整数。",
        aiSdkLabel: "AI SDK 通用参数 JSON",
        aiSdkHelp: "写入 generateText 顶层参数, 例如 maxOutputTokens, temperature, topP。会屏蔽 model/system/prompt 等关键键。",
        aiSdkDocsLink: "AI SDK 文档",
        providerOptionsLabel: "Provider 参数 JSON (自动包装为 {key})",
        providerOptionsHelp: "仅填写当前 Provider 的子对象, 系统会自动包装到 providerOptions.{key}。",
        providerDocsLink: "Provider 文档",
        setAsDefault: "设为默认模型"
      },
      deleteProvider: {
        title: "删除 Provider？",
        content: "将删除 {name} 及其所有模型。",
        ok: "删除",
        cancel: "取消"
      },
      deleteModel: {
        title: "删除模型？",
        content: "将删除模型 {name}。",
        ok: "删除",
        cancel: "取消"
      },
      errors: {
        invalidProviderForm: "请完整填写 Provider 必填项",
        invalidModelForm: "请完整填写模型必填项",
        invalidAiSdkJson: "AI SDK 通用参数 JSON 格式错误, 需要是对象",
        invalidProviderOptionsJson: "Provider 参数 JSON 格式错误, 需要是对象",
        duplicateProviderId: "Provider ID 已存在",
        duplicateModelId: "Model ID 已存在",
        modelListLoadFailed: "加载模型候选失败, 可手动输入 Model ID。",
        renameBlocked: "当前模型 ID 正被引用, 请先解除引用后再修改：{refs}",
        renameBlockedGlobalDefault: "全局默认模型",
        renameBlockedAgent: "Agent {id}",
        renameBlockedGeneric: "模型 ID 正被引用, 请先解除引用后再修改。"
      },
      saved: "已保存"
    },
    agentGlobalPrompts: {
      description: "管理提示词库条目。普通条目仅在 Agent 中选中后生效，Global System Prompt 会全局生效。",
      saving: "正在保存...",
      empty: "暂无提示词库条目，请先新增",
      actions: {
        add: "新增条目",
        edit: "编辑",
        delete: "删除"
      },
      modal: {
        createTitle: "新增提示词库条目",
        editTitle: "编辑提示词库条目",
        ok: "确定",
        cancel: "取消"
      },
      form: {
        idLabel: "条目 ID(自动生成)",
        titleLabel: "标题",
        promptLabel: "提示词",
        promptPlaceholder: "输入该条目的提示词内容",
        promptHelp: "最多 {maxKb}KB，当前 {bytes} bytes",
        systemPromptHint: "该条目作为系统提示词底座注入，影响所有 Agent。"
      },
      deleteConfirm: {
        title: "删除提示词库条目？",
        content: "将删除条目 {title}。",
        ok: "删除",
        cancel: "取消"
      },
      errors: {
        invalidForm: "请完整填写必填项",
        duplicateId: "条目 ID 已存在",
        titleTooLong: "标题过长，最多 {max} 个字符",
        promptTooLong: "提示词过长，最多 {maxKb}KB",
        reservedDelete: "系统提示词条目不允许删除"
      },
      saved: "已保存"
    },
    agentProfiles: {
      description: "配置 AI Agent 列表、可见范围、排序、可用工具与默认模型。",
      saving: "正在保存...",
      empty: "暂无 Agent，请先新增",
      sortHelp: "拖拽或使用上下箭头调整顺序。当前场景默认使用过滤后排在第一位的 Agent。",
      actions: {
        addAgent: "新增 Agent",
        edit: "编辑",
        delete: "删除",
        dragSort: "拖拽排序",
        moveUp: "上移",
        moveDown: "下移"
      },
      fields: {
        tools: "工具",
        mcpServers: "MCP Server",
        pluginTools: "插件工具",
        scope: "可用范围",
        globalPrompts: "提示词库",
        summary: "简介",
        defaultModel: "默认模型",
        useGlobalDefault: "默认模型",
        customDefaultModel: "使用自定义默认模型"
      },
      tools: {
        bash: "Bash",
        read: "Read",
        write: "Write",
        applyPatch: "Apply Patch",
        scratchpad: "Scratchpad",
        todolist: "Todo List",
        subtask: "Subtask",
        archiveSearch: "Archive Search",
        archiveRead: "Archive Read",
        archiveTail: "Archive Tail"
      },
      scope: {
        user: "仅用户可选",
        subtask: "仅子任务可选",
        both: "用户与子任务通用"
      },
      modal: {
        ok: "确定",
        cancel: "取消"
      },
      agentModal: {
        createTitle: "新增 Agent",
        editTitle: "编辑 Agent"
      },
      agentForm: {
        idLabel: "Agent ID(自动生成)",
        nameLabel: "名称",
        summaryLabel: "简介",
        summaryPlaceholder: "例如: 专注网络信息搜集与调研,并进行信息汇总整理",
        summaryHelp: "用一句话说明这个 Agent 的擅长场景和边界,重点写“何时使用”。",
        promptLabel: "角色设定",
        promptPlaceholder: "可选, 留空使用默认设定",
        promptBytesHelp: "最多 {maxKb}KB，当前 {bytes} bytes",
        globalPromptsPlaceholder: "选择提示词库条目",
        globalPromptsHelp: "支持多选，注入顺序按提示词库列表顺序。",
        mcpServersPlaceholder: "选择可用的 MCP Server",
        pluginToolsPlaceholder: "选择已启用插件提供的工具",
        pluginToolsHelp: "仅可选择全局已启用且状态为 Ready 的插件工具。",
        defaultModelCascaderPlaceholder: "选择默认模型策略",
        defaultModelModeLabel: "默认模型策略",
        defaultProviderLabel: "Provider",
        defaultProviderPlaceholder: "请选择 Provider",
        defaultModelLabel: "模型",
        defaultModelPlaceholder: "请选择模型"
      },
      deleteAgent: {
        title: "删除 Agent？",
        content: "将删除 Agent {name}。",
        ok: "删除",
        cancel: "取消"
      },
      errors: {
        invalidAgentForm: "请完整填写 Agent 必填项",
        duplicateAgentId: "Agent ID 已存在",
        defaultModelInvalid: "默认模型不存在, 请重新选择",
        promptTooLong: "角色设定过长，最多 {maxKb}KB"
      },
      saved: "已保存"
    },
    agentRuntime: {
      description: "配置 agent 运行时的全局参数（对所有会话生效）。",
      saving: "正在保存...",
      saved: "已保存",
      fields: {
        autoCompactThresholdPct: {
          label: "自动压缩阈值(%)",
          help: "当最近一次模型响应总 token 达到当前模型 context window * 阈值/100 时触发自动压缩。范围 50-99。"
        },
        modelTotalTimeoutMs: {
          label: "单次请求超时（秒）",
          help: "单次模型请求的总超时时间。达到后将中止该次请求并标记为失败。仅支持整数秒,0 表示关闭。"
        },
        modelIdleTimeoutMs: {
          label: "请求空闲超时（秒）",
          help: "单次模型请求在连续一段时间未收到任何流式 chunk（包括 reasoning/tool-call/finish）时中止。仅支持整数秒,0 表示关闭。"
        },
        modelRequestMaxRetries: {
          label: "模型重试最大次数",
          help: "仅在首包前失败时自动重试。0 表示不重试。"
        },
        sessionTerminalSoundEnabled: {
          label: "运行结束提示音",
          help: "当运行结束时播放提示音。对所有会话生效。"
        }
      }
    },
    agentMcp: {
      description: "管理全局 MCP Server 配置。新增/编辑时使用 JSON 输入。",
      saving: "正在保存...",
      empty: "暂无 MCP Server,请先新增",
      actions: {
        addServer: "新增 MCP Server",
        edit: "编辑",
        delete: "删除"
      },
      fields: {
        enabled: "启用",
        disabled: "禁用"
      },
      modal: {
        ok: "确定",
        cancel: "取消"
      },
      serverModal: {
        createTitle: "新增 MCP Server",
        editTitle: "编辑 MCP Server"
      },
      serverForm: {
        idLabel: "Server ID",
        jsonLabel: "配置 JSON",
        jsonHelp: "必须是对象,并包含 type=local 或 type=remote。",
        enabled: "启用该 Server"
      },
      deleteServer: {
        title: "删除 MCP Server？",
        content: "将删除 MCP Server {id}。",
        ok: "删除",
        cancel: "取消"
      },
      errors: {
        invalidForm: "请完整填写 MCP 表单",
        invalidJson: "配置 JSON 格式错误, 需要是对象",
        invalidType: "配置 JSON 必须包含 type=local 或 type=remote",
        duplicateServerId: "Server ID 已存在"
      },
      saved: "已保存"
    },
    agentPlugins: {
      description: "管理本地发现的工具插件，查看诊断信息，并控制全局启用状态。",
      saving: "正在保存...",
      empty: "暂未发现插件。请将插件包放到 <dataDir>/plugins 下。",
      saved: "已保存",
      actions: {
        refresh: "刷新",
        editConfig: "编辑配置"
      },
      fields: {
        enabled: "已启用",
        entry: "入口"
      },
      configModal: {
        title: "编辑插件配置 · {name}",
        maskedHint: "提示：后端可能会返回脱敏值（例如 ***）。保留 *** 表示该敏感值保持不变。",
        schemaFieldsTitle: "字段说明（来自 configSchema）",
        schemaFieldsEmpty: "当前插件未声明 configSchema 字段信息，可直接编辑 JSON。",
        rawSchemaTitle: "查看原始 Schema",
        schemaComplexHint: "该 schema 较复杂，字段说明仅供参考，最终以服务端校验为准。",
        editorTitle: "配置 JSON",
        editorPlaceholder: "请输入 JSON 对象",
        enableHint: "启用前请先补充必填字段：{fields}",
        actions: {
          generateTemplate: "生成模板"
        },
        schemaTable: {
          field: "字段",
          type: "类型",
          required: "必填",
          description: "说明",
          defaultOrExample: "默认值/示例"
        },
        errors: {
          emptyJson: "配置不能为空，请输入 JSON 对象。",
          objectExpected: "配置必须是 JSON 对象。",
          invalidJson: "JSON 格式错误。"
        }
      },
      state: {
        ready: "可用",
        disabled: "已禁用",
        invalidManifest: "Manifest 无效",
        incompatible: "版本不兼容",
        configInvalid: "配置无效",
        loadFailed: "加载失败",
        manifestMismatch: "Manifest 不匹配"
      }
    },
    agentChannelSenderAllowlist: {
      description: "配置可触发渠道会话运行的发送者名单。列表为空时默认拒绝。",
      emptyChannels: "当前未发现具备 channels 能力的插件，请先启用相关插件。",
      empty: "暂无白名单项",
      created: "已添加",
      removed: "已移除",
      saved: "已保存",
      updated: "已更新",
      modal: {
        createTitle: "添加 IM 用户",
        editTitle: "编辑 IM 用户"
      },
      fields: {
        channel: "渠道",
        senderId: "发送者 ID",
        role: "角色",
        remark: "备注",
        actions: "操作",
        senderIdPlaceholder: "例如 ou_xxx 或平台用户 ID",
        remarkPlaceholder: "可选，便于识别"
      },
      roles: {
        admin: "管理员",
        user: "普通用户"
      },
      actions: {
        add: "添加",
        edit: "编辑",
        remove: "移除"
      },
      errors: {
        channelRequired: "请选择渠道",
        senderIdRequired: "请输入发送者 ID",
        duplicate: "该渠道下的发送者已存在"
      }
    },
    security: {
      description: "查看主密钥来源与 SSH 主机信任状态，并提供必要的重置入口。",
      masterKeyTitle: "凭证主密钥",
      knownHostsTitle: "SSH known_hosts",
      fields: {
        source: "来源",
        keyId: "Key ID",
        createdAt: "创建时间",
        path: "路径"
      },
      resetHostPlaceholder: "输入 host，例如 git.company.com",
      resetTrust: "重置信任",
      resetHelp: "说明：当服务端主机指纹变化时，SSH 可能会报错；可在此删除旧记录后重试。",
      resetConfirm: {
        title: "确认重置该 host 的信任记录？",
        content: "重置后，下次 SSH 连接会重新记录主机指纹。",
        ok: "重置",
        cancel: "取消"
      },
      resetSuccess: "已重置"
    }
  },
  editor: {
    placeholder: {
      empty: "暂无打开内容",
      fileEditorComingSoon: "文件编辑能力将在后续阶段接入"
    }
  }
} as const;
