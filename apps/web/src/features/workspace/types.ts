import type { Component } from "vue";

export type ToolId = "codeReview" | "terminal" | "files" | "search" | "agent" | "editor";

export type HeaderAction = {
  id: string;
  label?: string;
  tooltip?: string;
  icon?: Component;
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
  groupKey?: string;
};

export type HeaderActionGroup = {
  key: string;
  actions: HeaderAction[];
};
