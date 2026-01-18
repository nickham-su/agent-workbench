export type ToolId = "codeReview" | "terminal" | "files" | "search";

export type HeaderAction = {
  id: string;
  label: string;
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
};

export type HeaderActionGroup = {
  key: string;
  actions: HeaderAction[];
};
