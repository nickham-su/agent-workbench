<template>
  <section class="dashboard-panel" :aria-label="title" :data-testid="testId">
    <header class="dashboard-panel-head">
      <h3>{{ title }}</h3>
      <div v-if="status || $slots.actions" class="dashboard-panel-actions"><slot name="actions" /><DashboardStatusBadge v-if="status" :status="status" /></div>
    </header>
    <div class="dashboard-panel-body"><slot /></div>
  </section>
</template>
<script setup lang="ts">
import DashboardStatusBadge from "./DashboardStatusBadge.vue";
defineProps<{ title: string; testId?: string; status?: "available" | "partial" | "unavailable" | "healthy" | "degraded" | "stale" | "disabled" }>();
</script>
<style scoped>
.dashboard-panel{min-width:0;background:var(--panel-bg-elevated);border:1px solid var(--border-color-secondary);border-radius:3px;overflow:hidden}
.dashboard-panel-head{min-height:43px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border-color-secondary)}
.dashboard-panel-head h3{font-size:13px;font-weight:600;margin:0;min-width:0}
.dashboard-panel-actions{display:flex;align-items:center;gap:8px;flex:none}
.dashboard-panel-body{padding:12px 14px;min-width:0}
</style>
