<template>
  <WorkspaceLayout :workspaceId="workspaceId" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import WorkspaceLayout from "./WorkspaceLayout.vue";

const route = useRoute();
const workspaceId = computed(() => String(route.params.workspaceId || ""));
</script>
