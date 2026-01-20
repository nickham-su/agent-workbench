<template>
  <div class="w-full h-full flex flex-col">
    <div class="flex items-center justify-between px-2 py-1.5 border-b border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)]">
      <div class="text-xs font-semibold">{{ t("files.title") }}</div>
      <div class="flex items-center gap-1">
        <a-tooltip :title="t('files.actions.refresh')" :mouseEnterDelay="0" :mouseLeaveDelay="0">
          <span class="inline-flex">
            <a-button size="small" type="text" :loading="treeLoading" @click="refreshRoot">
              <template #icon><ReloadOutlined /></template>
            </a-button>
          </span>
        </a-tooltip>
      </div>
    </div>
    <div class="flex-1 min-h-0 overflow-auto">
      <a-tree
        :key="treeKey"
        :tree-data="treeData"
        :load-data="onLoadData"
        :expandedKeys="expandedKeys"
        :selectedKeys="selectedKeys"
        blockNode
        showLine
        @update:expandedKeys="onExpandedKeysUpdate"
        @update:selectedKeys="onSelectedKeysUpdate"
        @select="onTreeSelect"
      >
        <template #title="{ title, dataRef }">
          <a-dropdown :trigger="['contextmenu']" class="block">
            <span
              class="block w-full select-none pr-2"
              @contextmenu.prevent="onNodeContextMenu(dataRef as TreeNode)"
              @dblclick.stop.prevent="onNodeDblClick(dataRef as TreeNode)"
            >
              {{ title }}
            </span>
            <template #overlay>
              <a-menu @click="onContextMenuClick">
                <a-menu-item v-if="selectedNode?.data.kind === 'dir'" key="newFile">
                  {{ t("files.actions.newFile") }}
                </a-menu-item>
                <a-menu-item v-if="selectedNode?.data.kind === 'dir'" key="newFolder">
                  {{ t("files.actions.newFolder") }}
                </a-menu-item>
                <a-menu-divider v-if="selectedNode?.data.kind === 'dir'" />
                <a-menu-item v-if="selectedNode?.data.kind === 'dir'" key="upload">
                  {{ t("files.actions.upload") }}
                </a-menu-item>
                <a-menu-item v-if="selectedNode" key="download">
                  {{ t("files.actions.download") }}
                </a-menu-item>
                <a-menu-divider v-if="selectedNode" />
                <a-menu-item v-if="selectedNode" key="copyName">
                  {{ t("files.actions.copyName") }}
                </a-menu-item>
                <a-menu-item v-if="showRepoPathAction" key="copyRepoPath">
                  {{ t("files.actions.copyRepoPath") }}
                </a-menu-item>
                <a-menu-item v-if="showWorkspacePathAction" key="copyWorkspacePath">
                  {{ t("files.actions.copyWorkspacePath") }}
                </a-menu-item>
                <a-menu-divider v-if="canRenameDelete" />
                <a-menu-item v-if="canRenameDelete" key="rename">{{ t("files.actions.rename") }}</a-menu-item>
                <a-menu-item v-if="canRenameDelete" key="delete" danger>{{ t("files.actions.delete") }}</a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>
        </template>
      </a-tree>
      <div v-if="!treeLoading && isTreeEmpty" class="p-2 text-xs text-[color:var(--text-tertiary)]">
        {{ t("files.placeholder.empty") }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { ReloadOutlined } from "@ant-design/icons-vue";
import type { TreeNode } from "../types";

const props = defineProps<{
  treeKey: number;
  treeData: TreeNode[];
  expandedKeys: string[];
  selectedKeys: string[];
  treeLoading: boolean;
  isTreeEmpty: boolean;
  selectedNode: TreeNode | null;
  canRenameDelete: boolean;
  showRepoPathAction: boolean;
  showWorkspacePathAction: boolean;
  refreshRoot: () => void;
  onLoadData: (node: any) => Promise<void> | void;
  onExpandedKeysUpdate: (keys: string[]) => void;
  onSelectedKeysUpdate: (keys: string[]) => void;
  onTreeSelect: (selectedKeys: string[], info: any) => void;
  onNodeContextMenu: (node: TreeNode) => void;
  onNodeDblClick: (node: TreeNode) => void;
  onContextMenuClick: (info: any) => void;
}>();

const { t } = useI18n();
</script>
