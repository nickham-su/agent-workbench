import type { FileEntry } from "@agent-workbench/shared";

export type TreeNode = {
  key: string;
  title: string;
  isLeaf: boolean;
  children?: TreeNode[];
  selectable?: boolean;
  data: FileEntry;
};
