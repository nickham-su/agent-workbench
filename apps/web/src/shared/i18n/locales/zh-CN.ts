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
    reset: "重置",
    default: "默认",
    loading: "正在加载…",
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
      delete: "删除"
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
      push: "推送"
    },
    repoSelector: {
      placeholder: "选择仓库",
      detached: "Detached HEAD"
    },
    tools: {
      codeReview: "代码审查",
      terminal: "终端",
      files: "文件"
    },
    dock: {
      moveTo: "移动到 {area}",
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
      base: "旧",
      current: "新",
      prevChange: "上一处差异",
      nextChange: "下一处差异",
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
      rename: "重命名",
      delete: "删除",
      refresh: "刷新",
      close: "关闭"
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
  settings: {
    title: "设置",
    tabs: {
      general: "常规",
      gitIdentity: "Git 身份",
      credentials: "凭证",
      network: "网络",
      security: "安全"
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
        diff: {
          label: "对比字号",
          help: "调整代码对比（Diff）字体大小（全局生效，自动保存到本地）。默认：{default}"
        }
      }
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
        add: "新增",
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
  }
} as const;
