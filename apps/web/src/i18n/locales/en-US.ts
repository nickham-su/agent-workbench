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
    reset: "Reset",
    default: "Default",
    loading: "Loading…",
    format: {
      parens: "({text})",
      parensSuffix: " ({text})"
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
    empty: "No repos",
    actions: {
      add: "Add repo",
      delete: "Delete"
    },
    create: {
      modalTitle: "Add repo",
      gitUrlLabel: "Git URL",
      gitUrlPlaceholder: "https://github.com/org/repo.git or git@github.com:org/repo.git",
      credentialLabel: "Credential (optional)",
      credentialPlaceholder: "Select credential (recommended for private repos)",
      credentialHelp: "If not selected, it will try to pick the default credential by URL host; otherwise configure it in Settings/Credentials."
    },
    deleteConfirm: {
      title: "Delete repo?",
      content: "Deleting will also remove the mirror directory; it will fail if referenced by any workspace.",
      ok: "Delete",
      cancel: "Cancel"
    },
    sync: {
      failed: "Repo sync failed",
      timeout: "Repo sync timed out. Please try again later."
    },
    syncStatus: {
      syncing: "Syncing",
      failed: "Failed"
    }
  },
  workspaces: {
    empty: "No workspaces",
    actions: {
      create: "Create workspace",
      delete: "Delete"
    },
    tooltip: {
      activeTerminals: "Active terminals"
    },
    create: {
      modalTitle: "Create workspace",
      modeLabel: "Create mode",
      modeExisting: "Pick existing repo",
      modeUrl: "Enter repo URL",
      repoUrlLabel: "Repo URL",
      repoUrlPlaceholder: "https://github.com/org/repo.git or git@github.com:org/repo.git",
      credentialLabel: "Credential (optional)",
      credentialPlaceholder: "Select credential (recommended for private repos)",
      credentialHelp: "If not selected, it will try to pick the default credential by URL host.",
      repoLabel: "Repo",
      repoPlaceholder: "Select repo",
      branchLabel: "Branch",
      branchPlaceholder: "Select branch",
      refreshBranches: "Refresh branches",
      urlTip: "Note: creating from URL requires syncing the repo first; after sync, it will create using the default branch.",
      defaultBranchUnknown: "Unable to determine the default branch. Sync the repo or choose a branch manually."
    },
    deleteConfirm: {
      title: "Delete workspace?",
      content: "This will close all terminals in the workspace and remove the worktree directory.",
      ok: "Delete",
      cancel: "Cancel"
    }
  },
  workspace: {
    title: "Workspace",
    actions: {
      checkout: "Switch branch",
      pull: "Pull",
      push: "Push"
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
  codeReview: {
    placeholder: {
      title: "Code review (placeholder)",
      desc: "Placeholder content for now. Later it will integrate staged/unstaged file list and diff view.",
      repo: "Repo",
      branch: "Branch",
      repoLine: "Repo: {url}",
      branchLine: "Branch: {branch}"
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
      base: "Old",
      current: "New",
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
      disconnectedLine0: "[Connection closed] Connection lost. Will retry automatically.",
      disconnectedLine1: "Details: code={code} reason={reason} wasClean={wasClean}",
      disconnectedLine2: "If occupied, click “Take over”.",
      closed: "[Connection closed, exitCode={exitCode}]",
      error: "[Error] {message}"
    }
  },
  settings: {
    title: "Settings",
    tabs: {
      general: "General",
      credentials: "Credentials",
      network: "Network",
      security: "Security"
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
      }
    },
    credentials: {
      description: "Manage Git credentials (HTTPS token / SSH key). Credentials can be reused per host and a default can be set.",
      empty: "No credentials",
      tags: {
        default: "Default"
      },
      actions: {
        add: "Add",
        edit: "Edit",
        delete: "Delete"
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
        caCertPlaceholder: "Paste PEM content (multiple blocks supported)"
      },
      actions: {
        save: "Save",
        refresh: "Refresh"
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
