<template>
  <WorkspaceLayout :workspaceId="workspaceId" :preview-enabled="previewEnabled" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { getCachedAuthStatus } from "@/features/auth/session";
import WorkspaceLayout from "./WorkspaceLayout.vue";

const route = useRoute();
const workspaceId = computed(() => String(route.params.workspaceId || ""));
const previewEnabled = computed(() => getCachedAuthStatus().previewEnabled);
</script>
