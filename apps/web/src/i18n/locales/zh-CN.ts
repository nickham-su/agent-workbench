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
  workbench: {
    tabs: {
      workspaces: "工作区",
      repos: "仓库",
      settings: "设置"
    }
  },
  repos: {
    empty: "暂无仓库",
    actions: {
      add: "添加仓库",
      delete: "删除"
    },
    create: {
      modalTitle: "添加仓库",
      gitUrlLabel: "Git URL",
      gitUrlPlaceholder: "https://github.com/org/repo.git 或 git@github.com:org/repo.git",
      credentialLabel: "凭证（可选）",
      credentialPlaceholder: "选择凭证（私有仓库推荐选择）",
      credentialHelp: "若未选择，将尝试按 URL host 自动匹配默认凭证；仍失败时可到 设置/凭证 配置。"
    },
    deleteConfirm: {
      title: "确认删除仓库？",
      content: "删除将同时删除镜像（mirror）目录；若存在工作区引用则会失败。",
      ok: "删除",
      cancel: "取消"
    },
    sync: {
      failed: "仓库同步失败",
      timeout: "仓库同步超时，请稍后重试"
    },
    syncStatus: {
      syncing: "同步中",
      failed: "失败"
    }
  },
  workspaces: {
    empty: "暂无工作区",
    actions: {
      create: "创建工作区",
      delete: "删除"
    },
    tooltip: {
      activeTerminals: "活跃终端数"
    },
    create: {
      modalTitle: "创建工作区",
      modeLabel: "创建方式",
      modeExisting: "选择已有仓库",
      modeUrl: "填写仓库 URL",
      repoUrlLabel: "仓库 URL",
      repoUrlPlaceholder: "https://github.com/org/repo.git 或 git@github.com:org/repo.git",
      credentialLabel: "凭证（可选）",
      credentialPlaceholder: "选择凭证（私有仓库推荐选择）",
      credentialHelp: "若未选择，将尝试按 URL host 自动匹配默认凭证。",
      repoLabel: "仓库",
      repoPlaceholder: "选择仓库",
      branchLabel: "分支",
      branchPlaceholder: "选择分支",
      refreshBranches: "刷新分支列表",
      urlTip: "提示：填写 URL 创建时需要先同步仓库；同步完成后会默认使用主分支创建工作区。",
      defaultBranchUnknown: "无法确定默认分支，请先同步仓库或手动选择分支"
    },
    deleteConfirm: {
      title: "确认删除工作区？",
      content: "会关闭该工作区下所有终端，并删除工作树（worktree）目录。",
      ok: "删除",
      cancel: "取消"
    }
  },
  workspace: {
    title: "工作区",
    actions: {
      checkout: "切换分支",
      pull: "拉取",
      push: "推送"
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
      desc: "这里先用占位内容，后续接入 staged/unstaged 文件列表与 diff 视图。",
      repo: "仓库",
      branch: "分支",
      repoLine: "仓库：{url}",
      branchLine: "分支：{branch}"
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
      disconnectedLine0: "[连接已断开] 连接已断开，将自动尝试重连。",
      disconnectedLine1: "详情：code={code} reason={reason} wasClean={wasClean}",
      disconnectedLine2: "若提示被占用，可点击“接管连接”。",
      closed: "[连接已关闭，exitCode={exitCode}]",
      error: "[错误] {message}"
    }
  },
  settings: {
    title: "设置",
    tabs: {
      general: "常规",
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
      }
    },
    credentials: {
      description: "管理 Git 凭证（HTTPS Token / SSH Key），可按 host 复用并设置默认凭证。",
      empty: "暂无凭证",
      tags: {
        default: "默认"
      },
      actions: {
        add: "新增",
        edit: "编辑",
        delete: "删除"
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
        caCertPlaceholder: "粘贴 PEM 内容，支持多个 PEM 块"
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
