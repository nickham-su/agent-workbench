<template>
  <div class="dashboard-page-head">
    <header class="dashboard-title-row">
      <div class="dashboard-title-copy"><h1>{{ title }}</h1><p>{{ subtitle }}</p></div>
      <div class="dashboard-toolbar"><slot name="controls" /></div>
    </header>
    <slot name="custom" />
    <nav class="dashboard-section-tabs" :aria-label="navigationLabel">
      <button v-for="item in sections" :key="item" type="button" :class="{ active: modelValue === item }" :aria-current="modelValue === item ? 'page' : undefined" @click="$emit('update:modelValue', item)">{{ labelFor(item) }}</button>
    </nav>
  </div>
</template>
<script setup lang="ts">
import type { DashboardSection } from "../dashboard-types";
defineProps<{ title: string; subtitle: string; navigationLabel: string; modelValue: DashboardSection; sections: readonly DashboardSection[]; labelFor: (section: DashboardSection) => string }>();
defineEmits<{ 'update:modelValue': [value: DashboardSection] }>();
</script>
<style scoped>
.dashboard-page-head{padding:18px 20px 0;border-bottom:1px solid var(--border-color-secondary);background:var(--panel-bg)}
.dashboard-title-row{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}
.dashboard-title-copy{min-width:0}.dashboard-title-copy h1{font-size:20px;line-height:28px;font-weight:600;margin:0}.dashboard-title-copy p{margin:3px 0 0;color:var(--text-color-secondary);font-size:12px;line-height:18px}
.dashboard-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.dashboard-section-tabs{display:flex;align-items:center;gap:20px;margin-top:14px;overflow-x:auto;scrollbar-width:thin}
.dashboard-section-tabs button{flex:none;height:37px;padding:0 1px;background:transparent;border:0;border-bottom:2px solid transparent;color:var(--text-color-secondary);cursor:pointer}
.dashboard-section-tabs button:hover,.dashboard-section-tabs button.active{color:#69b1ff}.dashboard-section-tabs button.active{border-bottom-color:#1677ff}
.dashboard-section-tabs button:focus-visible{outline:2px solid #69b1ff;outline-offset:-2px}
@media(max-width:720px){.dashboard-title-row{flex-direction:column;gap:10px}.dashboard-toolbar{justify-content:flex-start}.dashboard-section-tabs{margin-top:10px}}
</style>
