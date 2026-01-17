<template>
  <div class="h-full flex min-h-0">
    <div class="w-10 h-full flex flex-col border-r border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)]">
      <div class="flex flex-col items-center gap-1 py-1">
        <template v-for="toolId in leftTopToolbarToolIds" :key="toolId">
          <WorkspaceToolButton
            :title="toolTitle(toolId)"
            :icon="toolIcon(toolId)"
            :active="activeToolIdByArea.leftTop === toolId"
            :minimized="toolMinimized[toolId] ?? false"
            :dot="toolDots[toolId] ?? false"
            :can-move-up="canMoveUp(toolId)"
            :can-move-down="canMoveDown(toolId)"
            :moveTargets="moveTargets(toolId)"
            :contextMenuHint="contextMenuHint(toolId)"
            tooltipPlacement="right"
            @click="onToolIconClick(toolId)"
            @moveUp="() => moveToolUp(toolId)"
            @moveDown="() => moveToolDown(toolId)"
            @moveTo="(area) => moveTool(toolId, area)"
          />
        </template>
      </div>
      <div class="mt-auto flex flex-col items-center gap-1 py-1">
        <template v-for="toolId in leftBottomToolbarToolIds" :key="toolId">
          <WorkspaceToolButton
            :title="toolTitle(toolId)"
            :icon="toolIcon(toolId)"
            :active="activeToolIdByArea.leftBottom === toolId"
            :minimized="toolMinimized[toolId] ?? false"
            :dot="toolDots[toolId] ?? false"
            :can-move-up="canMoveUp(toolId)"
            :can-move-down="canMoveDown(toolId)"
            :moveTargets="moveTargets(toolId)"
            :contextMenuHint="contextMenuHint(toolId)"
            tooltipPlacement="right"
            @click="onToolIconClick(toolId)"
            @moveUp="() => moveToolUp(toolId)"
            @moveDown="() => moveToolDown(toolId)"
            @moveTo="(area) => moveTool(toolId, area)"
          />
        </template>
      </div>
    </div>

    <div :ref="onCenterEl" class="flex-1 min-w-0 min-h-0 relative bg-[var(--panel-bg)]">
      <div class="h-full min-h-0 min-w-0 grid relative" :style="centerStyle">
        <div
          v-if="showTop"
          :ref="onTopEl"
          class="min-h-0 min-w-0 grid relative"
          :class="showBottom ? 'border-b border-[var(--border-color-secondary)]' : ''"
          :style="topStyle"
        >
          <div v-if="showLeftTop" class="min-h-0 min-w-0 overflow-hidden" :class="showRightTop ? 'border-r border-[var(--border-color-secondary)]' : ''">
            <template v-if="visibleToolIdByArea.leftTop">
              <KeepAlive v-if="isKeepAlive(visibleToolIdByArea.leftTop)">
                <component
                  :is="toolView(visibleToolIdByArea.leftTop)"
                  :key="visibleToolIdByArea.leftTop"
                  v-bind="toolViewProps(visibleToolIdByArea.leftTop)"
                  v-on="toolViewListeners(visibleToolIdByArea.leftTop)"
                  class="h-full min-h-0 min-w-0"
                />
              </KeepAlive>
              <component
                v-else
                :is="toolView(visibleToolIdByArea.leftTop)"
                :key="visibleToolIdByArea.leftTop"
                v-bind="toolViewProps(visibleToolIdByArea.leftTop)"
                v-on="toolViewListeners(visibleToolIdByArea.leftTop)"
                class="h-full min-h-0 min-w-0"
              />
            </template>
          </div>
          <div v-if="showRightTop" class="min-h-0 min-w-0 overflow-hidden">
            <template v-if="visibleToolIdByArea.rightTop">
              <KeepAlive v-if="isKeepAlive(visibleToolIdByArea.rightTop)">
                <component
                  :is="toolView(visibleToolIdByArea.rightTop)"
                  :key="visibleToolIdByArea.rightTop"
                  v-bind="toolViewProps(visibleToolIdByArea.rightTop)"
                  v-on="toolViewListeners(visibleToolIdByArea.rightTop)"
                  class="h-full min-h-0 min-w-0"
                />
              </KeepAlive>
              <component
                v-else
                :is="toolView(visibleToolIdByArea.rightTop)"
                :key="visibleToolIdByArea.rightTop"
                v-bind="toolViewProps(visibleToolIdByArea.rightTop)"
                v-on="toolViewListeners(visibleToolIdByArea.rightTop)"
                class="h-full min-h-0 min-w-0"
              />
            </template>
          </div>

          <div
            v-if="showTopColsSplitter"
            class="absolute top-0 bottom-0"
            :class="splitterClassCol"
            :style="topColsSplitterStyle"
            role="separator"
            aria-orientation="vertical"
            :aria-label="t('workspace.dock.splitter.resizeTopLeftRight')"
            @pointerdown="onTopColsSplitterPointerDown"
          />
        </div>

        <div v-if="showBottom" class="min-h-0 min-w-0 overflow-hidden">
          <template v-if="visibleToolIdByArea.leftBottom">
            <KeepAlive v-if="isKeepAlive(visibleToolIdByArea.leftBottom)">
              <component
                :is="toolView(visibleToolIdByArea.leftBottom)"
                :key="visibleToolIdByArea.leftBottom"
                v-bind="toolViewProps(visibleToolIdByArea.leftBottom)"
                v-on="toolViewListeners(visibleToolIdByArea.leftBottom)"
                class="h-full min-h-0 min-w-0"
              />
            </KeepAlive>
            <component
              v-else
              :is="toolView(visibleToolIdByArea.leftBottom)"
              :key="visibleToolIdByArea.leftBottom"
              v-bind="toolViewProps(visibleToolIdByArea.leftBottom)"
              v-on="toolViewListeners(visibleToolIdByArea.leftBottom)"
              class="h-full min-h-0 min-w-0"
            />
          </template>
        </div>

        <div
          v-if="showTopBottomSplitter"
          class="absolute left-0 right-0"
          :class="splitterClassRow"
          :style="topBottomSplitterStyle"
          role="separator"
          aria-orientation="horizontal"
          :aria-label="t('workspace.dock.splitter.resizeTopBottom')"
          @pointerdown="onTopBottomSplitterPointerDown"
        />
      </div>
    </div>

    <div
      v-if="rightToolbarToolIds.length > 0"
      class="w-10 h-full flex flex-col items-center gap-1 py-1 border-l border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)]"
    >
      <template v-for="toolId in rightToolbarToolIds" :key="toolId">
        <WorkspaceToolButton
          :title="toolTitle(toolId)"
          :icon="toolIcon(toolId)"
          :active="activeToolIdByArea.rightTop === toolId"
          :minimized="toolMinimized[toolId] ?? false"
          :dot="toolDots[toolId] ?? false"
          :can-move-up="canMoveUp(toolId)"
          :can-move-down="canMoveDown(toolId)"
          :moveTargets="moveTargets(toolId)"
          :contextMenuHint="contextMenuHint(toolId)"
          tooltipPlacement="left"
          @click="onToolIconClick(toolId)"
          @moveUp="() => moveToolUp(toolId)"
          @moveDown="() => moveToolDown(toolId)"
          @moveTo="(area) => moveTool(toolId, area)"
        />
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { StyleValue, VNodeRef } from "vue";
import { useI18n } from "vue-i18n";
import type { DockArea } from "@/features/workspace/host";
import type { ToolId } from "@/features/workspace/types";
import WorkspaceToolButton from "@/features/workspace/WorkspaceToolButton.vue";

const props = defineProps<{
  leftTopToolbarToolIds: ToolId[];
  leftBottomToolbarToolIds: ToolId[];
  rightToolbarToolIds: ToolId[];
  activeToolIdByArea: Record<DockArea, ToolId | null>;
  toolMinimized: Record<ToolId, boolean | undefined>;
  visibleToolIdByArea: Record<DockArea, ToolId | null>;
  toolTitle: (toolId: ToolId) => string;
  toolIcon: (toolId: ToolId) => any;
  toolDots: Record<ToolId, boolean | undefined>;
  canMoveUp: (toolId: ToolId) => boolean;
  canMoveDown: (toolId: ToolId) => boolean;
  moveTargets: (toolId: ToolId) => { area: DockArea; label: string }[];
  contextMenuHint: (toolId: ToolId) => string;
  onToolIconClick: (toolId: ToolId) => void;
  moveToolUp: (toolId: ToolId) => void;
  moveToolDown: (toolId: ToolId) => void;
  moveTool: (toolId: ToolId, area: DockArea) => void;
  isKeepAlive: (toolId: ToolId) => boolean;
  toolView: (toolId: ToolId) => any;
  toolViewProps: (toolId: ToolId) => Record<string, unknown>;
  toolViewListeners: (toolId: ToolId) => Record<string, ((...args: any[]) => void) | undefined>;
  showTop: boolean;
  showBottom: boolean;
  showLeftTop: boolean;
  showRightTop: boolean;
  centerStyle: StyleValue;
  topStyle: StyleValue;
  showTopColsSplitter: boolean;
  showTopBottomSplitter: boolean;
  splitterClassCol: string;
  splitterClassRow: string;
  topColsSplitterStyle: StyleValue;
  topBottomSplitterStyle: StyleValue;
  onTopColsSplitterPointerDown: (evt: PointerEvent) => void;
  onTopBottomSplitterPointerDown: (evt: PointerEvent) => void;
  onCenterEl: VNodeRef;
  onTopEl: VNodeRef;
}>();

const { t } = useI18n();
</script>
