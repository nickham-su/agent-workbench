export default {
  app: {
    title: "AgentWorkbench"
  },
  common: {
    add: "Add",
    create: "Create",
    edit: "Edit",
    delete: "Delete",
    save: "Save",
    cancel: "Cancel",
    refresh: "Refresh",
    loading: "Loading...",
    reset: "Reset",
    default: "Default",
    format: {
      parens: "({text})",
      parensSuffix: " ({text})"
    }
  },
  gitIdentity: {
    modalTitle: "Set Git identity",
    form: {
      nameLabel: "Name",
      namePlaceholder: "e.g. Your Name",
      emailLabel: "Email",
      emailPlaceholder: "e.g. name{at}example.com",
      scopeLabel: "Scope"
    },
    scope: {
      session: "This commit only",
      repo: "This repo",
      global: "Global"
    },
    actions: {
      saveAndContinue: "Save & continue",
      cancel: "Cancel"
    }
  },
  auth: {
    login: {
      title: "Sign in",
      tokenLabel: "Token",
      tokenPlaceholder: "Enter access token",
      remember30d: "Remember for 30 days",
      submit: "Sign in",
      hint: "Tip: without remember, it lasts for this browser session only."
    }
  },
  workbench: {
    tabs: {
      workspaces: "Workspaces",
      repos: "Repos",
      settings: "Settings"
    }
  },
  repos: {
    emptyGuide: {
      title: "Add your first repo",
      lead: "After you add a Git URL, Workbench maintains a local mirror for faster workspace creation and branch discovery",
      autoSync: "You usually don't need to sync manually. Creating a workspace will sync to the latest automatically",
      incremental: "Sync is incremental and is typically much faster than a full fetch from the remote each time",
      supportPrefix: "Supports configuring ",
      supportAnd: " and ",
      supportSuffix: " in Settings"
    },
    search: {
      placeholder: "Search repos (URL)",
      empty: "No matching repos"
    },
    actions: {
      add: "Add repo",
      sync: "Sync",
      edit: "Edit",
      delete: "Delete"
    },
    create: {
      modalTitle: "Add repo",
      gitUrlLabel: "Git URL",
      gitUrlPlaceholder: "https://github.com/org/repo.git or git{at}github.com:org/repo.git",
      credentialLabel: "Credential (optional)",
      credentialPlaceholder: "Select credential (recommended for private repos)",
      credentialHelpPrefix: "Access failed? Configure in Settings: ",
      credentialHelpSuffix: "",
      credentialHostMismatch: "URL host is {urlHost}, but the selected credential host is {credHost}. Please pick a credential for the same host.",
      credentialKindMismatch: "URL protocol is {urlKind}, but the selected credential type is {credKind}. Switch the URL or pick a matching credential."
    },
    edit: {
      modalTitle: "Edit repo",
      credentialLabel: "Credential (optional)",
      credentialPlaceholder: "Select credential (recommended for private repos)",
      credentialHelp: "Sync again to validate after update.",
      credentialHostMismatch: "URL host is {urlHost}, but the selected credential host is {credHost}. Please pick a credential for the same host.",
      credentialKindMismatch: "URL protocol is {urlKind}, but the selected credential type is {credKind}. Switch the URL or pick a matching credential.",
      updated: "Repo updated"
    },
    deleteConfirm: {
      title: "Delete repo?",
      content: "Deleting will also remove the mirror directory; it will fail if referenced by any workspace.",
      ok: "Delete",
      cancel: "Cancel"
    },
    sync: {
      started: "Sync started",
      alreadySyncing: "Already syncing",
      success: "Sync completed",
      failed: "Repo sync failed",
      timeout: "Repo sync timed out. Please try again later."
    },
    syncStatus: {
      syncing: "Syncing",
      failed: "Failed"
    }
  },
  workspaces: {
    emptyGuide: {
      title: "Create your first workspace",
      lead: "A workspace is an isolated dev directory for running multiple tasks/agents in parallel, with reconnectable terminals",
      flowPrefix: "Typical flow:",
      flowCredNetPrefix: "Configure ",
      flowRepoCredential: "Repo credentials",
      flowCredNetAnd: " and ",
      flowCredNetSuffix: " in Settings (CA/proxy)",
      flowAddPrefix: "Add ",
      flowCreate: "Create and enter a workspace, open a terminal, install an AI agent CLI, and start using it"
    },
    search: {
      placeholder: "Search workspaces (title/repos)",
      empty: "No matching workspaces"
    },
    actions: {
      create: "Create workspace",
      rename: "Rename",
      delete: "Delete",
      attachRepo: "Add repo",
      detachRepo: "Remove repo"
    },
    tooltip: {
      activeTerminals: "{n} active terminals. Click to close"
    },
    create: {
      modalTitle: "Create workspace",
      repoLabel: "Repo",
      repoPlaceholder: "Select repo",
      titleLabel: "Title",
      titlePlaceholder: "Optional: defaults to concatenated repo names",
      terminalCredentialLabel: "Terminal credential",
      terminalCredentialHelp: "Apply this credential to terminals in this workspace",
      terminalCredentialDisabledWarning:
        "Using git in the terminal to connect to remotes may fail, or you may need to configure it manually.",
      terminalCredentialUnavailable:
        "Selected repos use different credentials; terminals can't apply them automatically. Configure git in the terminal to connect to remotes.",
      defaultBranchUnknown: "Unable to determine the default branch. Sync the repo first."
    },
    rename: {
      modalTitle: "Rename workspace",
      titleLabel: "Title",
      titlePlaceholder: "Enter a new workspace title",
      terminalCredentialAffectsNewOnly:
        "Only affects newly created terminals. Existing terminals must be closed and reopened to take effect."
    },
    deleteConfirm: {
      title: "Delete workspace?",
      content: "This will close all terminals in the workspace and remove the workspace directory.",
      ok: "Delete",
      cancel: "Cancel"
    },
    closeTerminalsConfirm: {
      title: "Close all terminals?",
      content: "This will close all active terminals in the workspace.",
      ok: "Close",
      cancel: "Cancel",
      partialFailed: "Some terminals failed to close: {failed}"
    }
  },
  workspace: {
    title: "Workspace",
    actions: {
      checkout: "Switch branch",
      pull: "Pull",
      push: "Push",
      attachRepo: "Add repo",
      detachRepo: "Remove repo"
    },
    repoSelector: {
      placeholder: "Select repo",
      detached: "Detached HEAD"
    },
    attachRepo: {
      modalTitle: "Add repo",
      ok: "Add",
      cancel: "Cancel",
      repoLabel: "Repo",
      repoPlaceholder: "Select repo",
      empty: "No repos available to add",
      success: "Repo added",
      downgraded: "Terminal credential disabled due to credential mismatch",
      errors: {
        alreadyExists: "Repo is already attached to this workspace",
        dirConflict: "Workspace repo directory conflict. Try again",
        prepareFailed: "Failed to prepare repo. Check credentials or network",
        defaultBranchUnknown: "Default branch is unknown. Sync the repo first",
        branchNotFound: "Target branch not found"
      }
    },
    detachRepo: {
      confirmTitle: "Remove repo?",
      confirmContent: "This will remove the repo directory from the workspace. Global repo list is not affected.",
      ok: "Remove",
      cancel: "Cancel",
      success: "Repo removed",
      disabledNoRepo: "No repo selected",
      disabledActiveTerminals: "There are {n} active terminals. Close them first",
      disabledBusy: "Another operation is in progress. Try again later",
      errors: {
        activeTerminals: "Active terminals detected. Cannot remove repo",
        notFound: "Repo is no longer attached"
      }
    },
    tools: {
      codeReview: "Code review",
      terminal: "Terminal",
      files: "Files",
      search: "Search",
      agent: "AI Agent"
    },
    dock: {
      moveTo: "Move to {area}",
      moveUp: "Move Up",
      moveDown: "Move Down",
      pinnedAt: "Pinned at {area}",
      areas: {
        leftTop: "Top-left",
        leftBottom: "Bottom",
        rightTop: "Top-right"
      },
      splitter: {
        resizeTopLeftRight: "Resize top split",
        resizeTopBottom: "Resize vertical split"
      }
    },
    splitter: {
      resizeTerminalPanel: "Resize terminal panel"
    },
    checkout: {
      modalTitle: "Switch branch",
      ok: "Switch",
      cancel: "Cancel",
      targetBranch: "Target branch",
      branchPlaceholder: "Select a branch",
      refreshBranches: "Refresh branches",
      tip: "Note: switching branches with uncommitted changes may fail or cause conflicts. For complex cases, use the terminal.",
      confirmTitle: "Switch branch?",
      confirmContent: "Uncommitted changes detected. Switching may fail or cause conflicts.",
      switchedTo: "Switched to {branch}"
    },
    pull: {
      confirmTitle: "Pull?",
      confirmContent: "Uncommitted changes detected. Pull may fail or cause conflicts. For complex cases, use the terminal.",
      okContinue: "Continue pull",
      cancel: "Cancel",
      updated: "Pulled latest commits",
      upToDate: "Already up to date"
    },
    push: {
      pushedTo: "Pushed to {remote}/{branch}",
      noUpstreamTitle: "No upstream",
      noUpstreamContent: "Set upstream and retry push?",
      okSetUpstreamAndPush: "Set upstream & push",
      cancel: "Cancel",
      nonFastForwardTitle: "Push rejected (non-fast-forward)",
      nonFastForwardContent: "Retry with force-with-lease?",
      okForceWithLease: "Retry with force-with-lease"
    }
  },
  agent: {
    empty: "No sessions yet. Create an AI client to start.",
    closedEmpty: "All client tabs are closed",
    actions: {
      newClient: "New client",
      creating: "Creating...",
      refresh: "Refresh",
      minimize: "Minimize",
      closeClient: "Close client",
      reopenClosed: "Reopen closed clients"
    },
    client: {
      tabLabel: "Session {index}",
      newTitle: "AI Client {time}",
      cancel: "Cancel run",
      cancelConfirmTitle: "Cancel current run?",
      cancelConfirmContent: "This stops the current execution and keeps all messages. The currently running AI/tool item will be marked as cancelled.",
      cancelled: "Current run cancelled",
      welcome: "Hi, I can help you get tasks done.",
      reachedTop: "Reached the beginning",
      contextBoundary: "Context boundary",
      inputPlaceholder: "Type a message, Enter to send, Tab to switch agent",
      inputPlaceholderNoAgent: "Create an agent before sending messages",
      noAgentHint: "No available agent, please create one first",
      goCreateAgent: "Create agent",
      chooseSession: "Choose session",
      chooseSessionTitle: "Choose a session to continue",
      noSessionToChoose: "No previous session available",
      sessionEmptyPreview: "(No user messages in this session)",
      runNoticeLabel: "Run notice",
      runNoticeEmpty: "No runtime notice",
      lastTotalTokens: "Total Tokens",
      backToParent: "Back to parent session",
      parentSessionMissing: "Parent session not found",
      readonlySubtaskHint: "This subtask session is read-only",
      subtaskCardTitle: "Subtask",
      subtaskMode: "Mode",
      subtaskModeNew: "New session",
      subtaskModeFork: "Inherit context",
      subtaskModeExisting: "Reuse session",
      subtaskAgent: "Agent",
      subtaskSessionId: "Session ID",
      todoListCardTitle: "Todo list",
      todoListSummary: "Total {total}, in progress {inProgress}, pending {pending}, completed {completed}, cancelled {cancelled}",
      todoListEmpty: "Todo list is empty",
      applyPatchCardTitle: "Patch changes",
      applyPatchPreview: "Pending approval preview",
      applyPatchApplied: "Applied",
      applyPatchFileCount: "Files",
      applyPatchLineStats: "Line changes",
      applyPatchFrom: "From",
      applyPatchNoFiles: "No file diffs available",
      applyPatchOmittedFiles: "{count} more files are not shown",
      fork: "Fork from here",
      forked: "Created a new client from this message",
      revert: "Revert to here",
      revertTargetMissing: "No previous message found to revert to",
      revertConfirmTitle: "Revert to this message?",
      revertConfirmContent: "This will revert to before this message and put it back into the input box. Messages after this point will become hidden from current timeline.",
      revertConfirmTitleAssistant: "Revert to this assistant message?",
      revertConfirmContentAssistant: "This will revert to this assistant message and keep it in the timeline. Messages after this point will become hidden from current timeline.",
      reverted: "Reverted to selected message",
      approve: "Approve",
      deny: "Deny",
      roles: {
        user: "You",
        assistant: "Assistant",
        tool: "Tool",
        system: "System"
      },
      compactionArchivedHint: "Earlier messages have been archived",
      slashCommandHintTitle: "Commands",
      slashCommandHintStrictOnly: "Exact match",
      slashCommandHintNoMatch: "No matching command: /{query}",
      slashCommands: {
        compact: {
          summary: "Compact the current session context"
        },
        clear: {
          summary: "Start a new task and archive current visible context"
        }
      }
    }
  },
  codeReview: {
    placeholder: {
      title: "Code review (placeholder)",
      desc: "Review changes, staging, and diffs for the current repo here.",
      selectRepo: "Select a repo to continue."
    },
    unstaged: "Unstaged",
    staged: "Staged",
    actions: {
      stageAll: "Stage all",
      discardAll: "Discard all",
      refresh: "Refresh",
      stage: "Stage",
      unstageAll: "Unstage all",
      unstage: "Unstage",
      commit: "Commit",
      commitEllipsis: "Commit…",
      commitAndPush: "Commit & push",
      cancel: "Cancel"
    },
    status: {
      noChanges: "No changes"
    },
    file: {
      oldPath: "From: {oldPath}"
    },
    discard: {
      deleteUntracked: "Delete untracked file",
      discardChanges: "Discard changes",
      confirmDeleteTitle: "Delete?",
      confirmDiscardTitle: "Discard?",
      okDelete: "Delete",
      okDiscard: "Discard",
      cancel: "Cancel",
      deleted: "Untracked file deleted",
      discarded: "Changes discarded",
      confirmAllTitle: "Discard all?",
      confirmAllContent: "This will discard all unstaged changes and delete untracked files (except ignored files).",
      okDiscardAll: "Discard all",
      discardedAll: "All discarded",
      preview: {
        untracked: "Will delete untracked file: {path}",
        rename: "Will revert rename: {oldPath} → {path}",
        changes: "Will discard unstaged changes for: {path}"
      }
    },
    diff: {
      resizeFileList: "Resize file list",
      prevChange: "Previous change",
      nextChange: "Next change",
      viewFile: "View file",
      inline: "Inline",
      sideBySide: "Side-by-side",
      selectToCompare: "Select a file on the left to view diff",
      notPreviewableTitle: "Preview not available for this file",
      baseReason: "Old: {reason}",
      currentReason: "New: {reason}",
      loading: "Loading…"
    },
    commit: {
      modalTitle: "Commit",
      messageLabel: "Commit message",
      messagePlaceholder: "Enter commit message",
      summary: "Will commit {count} file(s)",
      committed: "Committed {sha}"
    },
    preview: {
      previewable: "Previewable",
      tooLarge: "Too large{bytesSuffix}",
      binary: "Binary file{bytesSuffix}",
      decodeFailed: "Failed to decode as UTF-8{bytesSuffix}",
      unsafePath: "Unsafe path{bytesSuffix}",
      notPreviewable: "Not previewable{bytesSuffix}"
    }
  },
  terminal: {
    panel: {
      collapse: "Collapse terminal panel"
    },
    empty: {
      title: "No terminals yet. Click to open terminal.",
      create: "Open terminal",
      creating: "Creating…"
    },
    tab: {
      name: "Terminal {index}",
      close: "Close terminal"
    },
    layout: {
      moveRight: "Move to right",
      moveBottom: "Move to bottom"
    },
    confirmClose: {
      title: "Close terminal?",
      content: "This will kill the corresponding tmux session.",
      ok: "Close",
      cancel: "Cancel"
    },
    occupied: {
      status: "Connection occupied (connected elsewhere)",
      takeover: "Take over"
    },
    takeover: {
      title: "Take over connection?",
      content: "Taking over will disconnect this terminal from other pages/devices.",
      ok: "Take over",
      cancel: "Cancel"
    },
    copyFailed: "Copy failed: {reason}",
    hint: {
      autoReconnectFailedLine0: "[Auto reconnect failed] Still unable to connect after {attempts} attempts.",
      autoReconnectFailedLine1: "Server may be unavailable or the network is unstable. Will retry later.",
      autoReconnectFailedLine2: "If you suspect it is connected elsewhere, refresh to see whether it is marked as occupied.",
      autoReconnecting: "[Auto reconnecting] Attempt {attempt}, reconnecting in {seconds}s…",
      connectFailedLine0: "[Connection failed] Unable to create WebSocket connection.",
      connectFailedLine1: "Try refreshing the page or retry later.",
      blockedLine0: "[Connection occupied] Connected on another page/device.",
      blockedLine1: "Details: code={code} reason={reason} wasClean={wasClean}",
      blockedLine2: "Click “Take over” to force takeover (disconnecting the other connection).",
      unauthorizedLine0: "[Unauthorized] Session expired. Please sign in again.",
      unauthorizedLine1: "Details: code={code} reason={reason} wasClean={wasClean}",
      disconnectedLine0: "[Connection closed] Connection lost. Will retry automatically.",
      disconnectedLine1: "Details: code={code} reason={reason} wasClean={wasClean}",
      disconnectedLine2: "If occupied, click “Take over”.",
      closed: "[Connection closed, exitCode={exitCode}]",
      error: "[Error] {message}"
    }
  },
  files: {
    title: "Files",
    actions: {
      newFile: "New file",
      newFolder: "New folder",
      upload: "Upload",
      copyName: "Copy name",
      copyPath: "Copy repo path",
      copyRepoPath: "Copy repo path",
      copyWorkspacePath: "Copy workspace path",
      download: "Download",
      rename: "Rename",
      delete: "Delete",
      refresh: "Refresh",
      close: "Close",
      closeOthers: "Close others",
      closeAll: "Close all"
    },
    copy: {
      nameCopied: "Name copied",
      pathCopied: "Path copied",
      repoPathCopied: "Repo path copied",
      workspacePathCopied: "Workspace path copied",
      failed: "Copy failed"
    },
    upload: {
      uploading: "Uploading…",
      success: "Upload complete",
      partialFailed: "Upload failed: {names}"
    },
    status: {
      saving: "Saving…"
    },
    resizeFileList: "Resize file list",
    placeholder: {
      selectRepo: "Select a repo",
      openFile: "Select a file on the left to open",
      empty: "No files"
    },
    form: {
      nameLabel: "Name",
      namePlaceholder: "Enter name",
      renamePlaceholder: "Enter new name",
      nameRequired: "Name is required",
      nameInvalid: "Name must not include / or \\"
    },
    createFile: {
      title: "New file"
    },
    createFolder: {
      title: "New folder"
    },
    rename: {
      title: "Rename"
    },
    deleteConfirm: {
      title: "Delete?",
      content: "This will delete the selected file or folder.",
      loadedHint: "Loaded items: {count}",
      ok: "Delete",
      cancel: "Cancel"
    },
    closeConfirm: {
      title: "Close unsaved file?",
      content: "This file has unsaved changes. Close anyway?",
      ok: "Close",
      cancel: "Cancel"
    },
    conflict: {
      title: "Save conflict",
      content: "The file was modified externally. Choose an action.",
      reload: "Reload",
      force: "Force overwrite"
    },
    preview: {
      tooLarge: "File too large to preview",
      binary: "Binary file, cannot preview",
      decodeFailed: "Cannot decode file",
      unsafePath: "Unsafe path",
      missing: "File not found",
      unavailable: "Preview unavailable"
    }
  },
  search: {
    placeholder: {
      selectRepo: "Select a repo",
      query: "Enter search text",
      queryEmpty: "Enter search text"
    },
    scope: {
      global: "Global",
      repos: "Specific repos",
      reposPlaceholder: "Select repos"
    },
    options: {
      regex: "Regex",
      caseSensitive: "Case",
      wholeWord: "Whole word"
    },
    actions: {
      search: "Search",
      viewFile: "View file"
    },
    status: {
      idle: "Enter search text to search",
      searching: "Searching…",
      error: "Search failed",
      empty: "No results",
      results: "{count} results · {tookMs}ms",
      truncated: "Truncated",
      timedOut: "Timed out"
    },
    hint: {
      ignore: "Respects .gitignore/.ignore",
      hidden: "Includes hidden files"
    },
    preview: {
      empty: "No preview"
    }
  },
  settings: {
    title: "Settings",
    tabs: {
      general: "General",
      search: "Search",
      gitIdentity: "Git Identity",
      credentials: "Credentials",
      network: "Network",
      agentProviders: "Model Providers",
      agentGlobalPrompts: "Prompt Library",
      agentMcp: "MCP",
      agentProfiles: "Role Profiles",
      agentRuntime: "Runtime",
      security: "Security"
    },
    groups: {
      basic: "Basics",
      identity: "Identity & Credentials",
      networkSecurity: "Network & Security",
      agent: "Agent"
    },
    general: {
      language: {
        label: "Language",
        help: "Change UI language (applies immediately and is saved locally).",
        options: {
          "zh-CN": "简体中文",
          "en-US": "English"
        },
        changed: "Language updated"
      },
      fontSize: {
        terminal: {
          label: "Terminal font size",
          help: "Adjust terminal font size (global, saved locally). Default: {default}"
        },
        editor: {
          label: "Editor font size",
          help: "Adjust editor font size (includes Diff view, global, saved locally). Default: {default}"
        }
      }
    },
    search: {
      description: "Configure default ignore globs for search (one glob per line).",
      excludeGlobs: {
        label: "Ignore globs",
        help: "Example: node_modules/**, dist/**, .venv/**",
        ignoreHint: "Search respects .gitignore/.ignore and always ignores .git/**"
      },
      actions: {
        save: "Save",
        refresh: "Refresh"
      },
      saved: "Saved"
    },
    gitIdentity: {
      description: "Configure global Git identity (user.name / user.email).",
      form: {
        nameLabel: "Global user.name",
        namePlaceholder: "e.g. Your Name",
        emailLabel: "Global user.email",
        emailPlaceholder: "e.g. name{at}example.com"
      },
      actions: {
        save: "Save",
        refresh: "Refresh",
        clearAll: "Clear all identity"
      },
      saved: "Saved",
      cleared: "Cleared",
      clearedWithErrors: "Cleared (failed in {count} workspaces)",
      clearAllConfirm: {
        title: "Clear all identity?",
        content: "This clears global config and removes local user.name/user.email from all workspace repos.",
        ok: "Clear",
        cancel: "Cancel"
      }
    },
    credentials: {
      description: "Manage Git credentials (HTTPS token / SSH key). Credentials can be reused per host and a default can be set.",
      empty: "No credentials",
      copied: "Copied",
      copyFailed: "Copy failed, please select and copy manually",
      tags: {
        default: "Default"
      },
      actions: {
        add: "Add",
        edit: "Edit",
        delete: "Delete",
        generateSshKey: "Generate key",
        copyPublicKey: "Copy public key"
      },
      modal: {
        createTitle: "Create credential",
        editTitle: "Edit credential",
        ok: "Save",
        cancel: "Cancel"
      },
      form: {
        hostLabel: "Host",
        hostPlaceholder: "e.g. github.com or git.company.com",
        kindLabel: "Type",
        kindHttps: "HTTPS",
        kindSsh: "SSH",
        labelLabel: "Label (optional)",
        labelPlaceholder: "e.g. GitHub Personal / Company GitLab",
        usernameLabel: "Username (optional)",
        usernamePlaceholderHttps: "May be required for self-hosted Git services",
        usernamePlaceholderSsh: "Usually git",
        secretPlaceholder: "Saved secret will not be shown",
        generateSshHelp: "Generates a keypair, fills the private key, and shows the public key for copying to your Git provider.",
        publicKeyLabel: "SSH public key",
        publicKeyHelp: "Add the public key to your account SSH keys or repo deploy keys.",
        isDefault: "Set as default credential for this host",
        secretLabel: {
          httpsCreate: "Token",
          httpsEdit: "Token (leave blank to keep unchanged)",
          sshCreate: "SSH private key (no passphrase)",
          sshEdit: "SSH private key (leave blank to keep unchanged)"
        }
      },
      tip: "Tip: passphrase-protected SSH keys are not supported yet. The first connection will record host fingerprints; if fingerprints change, reset trust in Security.",
      deleteConfirm: {
        title: "Delete credential?",
        content: "Deletion will fail if referenced by any repo.",
        ok: "Delete",
        cancel: "Cancel"
      }
    },
    network: {
      description: "Configure proxy and enterprise CA certificate (for self-hosted Git services).",
      form: {
        httpProxyLabel: "HTTP_PROXY",
        httpsProxyLabel: "HTTPS_PROXY",
        noProxyLabel: "NO_PROXY",
        httpProxyPlaceholder: "e.g. http://127.0.0.1:7890",
        httpsProxyPlaceholder: "e.g. http://127.0.0.1:7890",
        noProxyPlaceholder: "e.g. localhost,127.0.0.1,.company.com",
        caCertLabel: "Enterprise CA certificate (PEM, optional)",
        caCertPlaceholder: "Paste PEM content (multiple blocks supported)",
        applyToTerminalLabel: "Apply to terminals",
        applyToTerminalEffect: "Effect: inject proxy/cert into new terminal sessions; with credentials only, the terminal may still be unable to access internal Git (proxy or CA cert may be required).",
        applyToTerminalRisk: "Risk: if proxy URLs include username/password, they may leak via terminal environment variables or process info."
      },
      actions: {
        save: "Save",
        refresh: "Refresh"
      },
      saved: "Saved"
    },
    agentProviders: {
      description: "Manage AI providers and models. Add or edit providers, then manage models under each provider.",
      saving: "Saving...",
      empty: "No providers yet. Add one to start.",
      actions: {
        save: "Save",
        refresh: "Refresh",
        addProvider: "Add provider",
        manageModels: "Manage models",
        addModel: "Add model",
        copy: "Copy",
        edit: "Edit",
        delete: "Delete",
        setDefault: "Set default"
      },
      fields: {
        baseURL: "Base URL",
        providerOptionsKey: "Provider Options Key",
        apiKey: "API Key",
        apiKeyNotSet: "Not set",
        apiKeySet: "Updated",
        apiKeyKeep: "Keep unchanged",
        models: "Models",
        noModels: "No models"
      },
      modal: {
        ok: "OK",
        cancel: "Cancel"
      },
      providerModal: {
        createTitle: "Add provider",
        editTitle: "Edit provider"
      },
      providerForm: {
        idLabel: "Provider ID (auto)",
        nameLabel: "Name",
        npmLabel: "Provider Type",
        baseUrlLabel: "Base URL",
        apiKeyLabel: "API Key",
        apiKeyPlaceholder: "Enter API key (optional)",
        apiKeyEditPlaceholder: "Enter new API key (leave blank to keep)",
        apiKeyCreateHelp: "You can leave it blank for now and fill it later.",
        apiKeyEditHelp: "Leave blank to keep the existing key.",
        clearApiKey: "Clear existing API key"
      },
      modelModal: {
        createTitle: "Add model",
        editTitle: "Edit model",
        delete: "Delete model"
      },
      modelManager: {
        title: "Manage models - {name}",
        empty: "No models"
      },
      modelForm: {
        idLabel: "Model Internal ID (auto)",
        providerModelIdLabel: "Provider Model ID",
        nameLabel: "Display name",
        contextWindowTokensLabel: "Context Window Tokens",
        contextWindowTokensHelp: "Context window limit for this model, used as the base of auto-compaction threshold calculation. Must be a positive integer.",
        aiSdkLabel: "AI SDK Shared Params JSON",
        aiSdkHelp: "Mapped to generateText top-level options, e.g. maxOutputTokens, temperature, topP. Reserved keys like model/system/prompt are blocked.",
        aiSdkDocsLink: "AI SDK docs",
        providerOptionsLabel: "Provider Params JSON (auto wrapped as {key})",
        providerOptionsHelp: "Only provide the current provider sub-object. The system wraps it into providerOptions.{key} automatically.",
        providerDocsLink: "Provider docs",
        setAsDefault: "Set as default model"
      },
      deleteProvider: {
        title: "Delete provider?",
        content: "This will delete {name} and all its models.",
        ok: "Delete",
        cancel: "Cancel"
      },
      deleteModel: {
        title: "Delete model?",
        content: "This will delete model {name}.",
        ok: "Delete",
        cancel: "Cancel"
      },
      errors: {
        invalidProviderForm: "Please complete required provider fields",
        invalidModelForm: "Please complete required model fields",
        invalidAiSdkJson: "Invalid AI SDK params JSON, object expected",
        invalidProviderOptionsJson: "Invalid provider params JSON, object expected",
        duplicateProviderId: "Provider ID already exists",
        duplicateModelId: "Model ID already exists"
      },
      saved: "Saved"
    },
    agentGlobalPrompts: {
      description: "Manage prompt library entries. Entries take effect only when selected by an agent profile.",
      saving: "Saving...",
      empty: "No prompt library entries yet. Add one to start.",
      actions: {
        add: "Add entry",
        edit: "Edit",
        delete: "Delete"
      },
      modal: {
        createTitle: "Add prompt library entry",
        editTitle: "Edit prompt library entry",
        ok: "OK",
        cancel: "Cancel"
      },
      form: {
        idLabel: "Entry ID (auto)",
        titleLabel: "Title",
        promptLabel: "Prompt",
        promptPlaceholder: "Enter prompt text for this entry",
        promptHelp: "Up to {maxKb}KB, current {bytes} bytes"
      },
      deleteConfirm: {
        title: "Delete prompt library entry?",
        content: "This will delete entry {title}.",
        ok: "Delete",
        cancel: "Cancel"
      },
      errors: {
        invalidForm: "Please complete required fields",
        duplicateId: "Entry ID already exists",
        titleTooLong: "Title is too long. Maximum {max} characters",
        promptTooLong: "Prompt is too long. Maximum {maxKb}KB"
      },
      saved: "Saved"
    },
    agentProfiles: {
      description: "Configure AI agents, default agent, tool permissions, and default model.",
      saving: "Saving...",
      empty: "No agents yet. Add one to start.",
      actions: {
        addAgent: "Add agent",
        edit: "Edit",
        delete: "Delete",
        setDefault: "Set default"
      },
      fields: {
        tools: "Tools",
        mcpServers: "MCP Servers",
        globalPrompts: "Prompt library",
        summary: "Summary",
        permissions: "Permissions",
        defaultModel: "Default model",
        useGlobalDefault: "Use global default model",
        customDefaultModel: "Use custom default model"
      },
      tools: {
        bash: "Bash",
        read: "Read",
        write: "Write",
        applyPatch: "Apply Patch",
        todolist: "Todo List",
        subtask: "Subtask",
        archiveSearch: "Archive Search",
        archiveRead: "Archive Read",
        archiveTail: "Archive Tail"
      },
      permissions: {
        allowRead: "Allow Read",
        allowWrite: "Allow Write",
        allowBash: "Allow Bash"
      },
      modal: {
        ok: "OK",
        cancel: "Cancel"
      },
      agentModal: {
        createTitle: "Add agent",
        editTitle: "Edit agent"
      },
      agentForm: {
        idLabel: "Agent ID (auto)",
        nameLabel: "Name",
        summaryLabel: "Summary",
        summaryPlaceholder: "e.g. Focused on web information gathering and research, with structured synthesis",
        summaryHelp: "Use one sentence to describe when this agent should be used and its boundaries.",
        promptLabel: "Role setup",
        promptPlaceholder: "Optional. Leave empty to use default setup",
        promptBytesHelp: "Up to {maxKb}KB, current {bytes} bytes",
        globalPromptsPlaceholder: "Select prompt library entries",
        globalPromptsHelp: "Multi-select supported. Injection order follows the prompt library list order.",
        mcpServersPlaceholder: "Select allowed MCP servers",
        defaultModelCascaderPlaceholder: "Select default model strategy",
        defaultModelModeLabel: "Default model strategy",
        defaultProviderLabel: "Provider",
        defaultProviderPlaceholder: "Select a provider",
        defaultModelLabel: "Model",
        defaultModelPlaceholder: "Select a model",
        setAsDefault: "Set as default agent"
      },
      deleteAgent: {
        title: "Delete agent?",
        content: "This will delete agent {name}.",
        ok: "Delete",
        cancel: "Cancel"
      },
      errors: {
        invalidAgentForm: "Please complete required agent fields",
        duplicateAgentId: "Agent ID already exists",
        defaultModelInvalid: "Default model does not exist, please reselect",
        promptTooLong: "Role setup is too long. Maximum {maxKb}KB"
      },
      saved: "Saved"
    },
    agentRuntime: {
      description: "Configure global runtime options (applies to all sessions).",
      saving: "Saving...",
      saved: "Saved",
      fields: {
        autoCompactThresholdPct: {
          label: "Auto-compaction threshold (%)",
          help: "Auto-compaction triggers when last response total tokens reach current model context window * threshold/100. Range: 50-90."
        },
        modelTotalTimeoutMs: {
          label: "Model total timeout (seconds)",
          help: "Total timeout for a single model request. When reached, the request is aborted and the run fails. Integer seconds only; 0 disables."
        },
        modelIdleTimeoutMs: {
          label: "Model idle timeout (seconds)",
          help: "Abort when no streaming chunk arrives for a period (including reasoning/tool-call/finish). Integer seconds only; 0 disables."
        },
        modelRequestMaxRetries: {
          label: "Model max retries",
          help: "Automatically retries only when a request fails before receiving the first chunk. 0 disables retries."
        }
      }
    },
    agentMcp: {
      description: "Manage global MCP server configuration. Use JSON input when adding or editing.",
      saving: "Saving...",
      empty: "No MCP servers yet. Add one to start.",
      actions: {
        addServer: "Add MCP server",
        edit: "Edit",
        delete: "Delete"
      },
      fields: {
        enabled: "Enabled",
        disabled: "Disabled"
      },
      modal: {
        ok: "OK",
        cancel: "Cancel"
      },
      serverModal: {
        createTitle: "Add MCP server",
        editTitle: "Edit MCP server"
      },
      serverForm: {
        idLabel: "Server ID",
        jsonLabel: "Config JSON",
        jsonHelp: "Must be an object and include type=local or type=remote.",
        enabled: "Enable this server"
      },
      deleteServer: {
        title: "Delete MCP server?",
        content: "This will delete MCP server {id}.",
        ok: "Delete",
        cancel: "Cancel"
      },
      errors: {
        invalidForm: "Please complete required MCP fields",
        invalidJson: "Invalid MCP config JSON, object expected",
        invalidType: "Config JSON must include type=local or type=remote",
        duplicateServerId: "Server ID already exists"
      },
      saved: "Saved"
    },
    security: {
      description: "View master key source and SSH trust status, and provide necessary reset actions.",
      masterKeyTitle: "Credential master key",
      knownHostsTitle: "SSH known_hosts",
      fields: {
        source: "source",
        keyId: "keyId",
        createdAt: "createdAt",
        path: "path"
      },
      resetHostPlaceholder: "Enter host, e.g. git.company.com",
      resetTrust: "Reset trust",
      resetHelp: "If the server host fingerprint changes, SSH may fail. You can remove the old record here and retry.",
      resetConfirm: {
        title: "Reset trust for this host?",
        content: "After reset, the next SSH connection will record the host fingerprint again.",
        ok: "Reset",
        cancel: "Cancel"
      },
      resetSuccess: "Reset completed"
    }
  }
} as const;
