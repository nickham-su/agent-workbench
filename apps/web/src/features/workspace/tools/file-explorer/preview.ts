import { isWorkspacePreviewEntryPath } from "@agent-workbench/shared";

type PreviewNode = Readonly<{ data: Readonly<{ kind: string; path: string }> }>;

export type PreviewFormElement = {
  method: string;
  target: string;
  action: string;
  style: { display: string };
  appendChild(child: PreviewInputElement): unknown;
  submit(): void;
};

export type PreviewInputElement = {
  type: string;
  name: string;
  value: string;
};

export type PreviewDocument = {
  createElement(tagName: "form"): PreviewFormElement;
  createElement(tagName: "input"): PreviewInputElement;
  body: {
    appendChild(child: PreviewFormElement): unknown;
    removeChild(child: PreviewFormElement): unknown;
  };
};

/** UI-only eligibility check. The server repeats every security and entry validation. */
export function canOpenWorkspacePreview(params: { previewEnabled: boolean; node: PreviewNode | null }): boolean {
  return params.previewEnabled && params.node?.data.kind === "file" && isWorkspacePreviewEntryPath(params.node.data.path);
}

/** Builds an action target from the node selected at click time, never from a cached path. */
export function getWorkspacePreviewTarget(params: { previewEnabled: boolean; node: PreviewNode | null }): string | null {
  return canOpenWorkspacePreview(params) ? params.node!.data.path : null;
}

/**
 * Opens the main-origin endpoint synchronously so browsers honor target=_blank
 * without exposing the isolated preview origin to the Web bundle.
 */
export function openWorkspacePreview(params: { workspaceId: string; path: string; documentRef: PreviewDocument }): void {
  const form = params.documentRef.createElement("form");
  form.method = "post";
  form.target = "_blank";
  form.action = `/api/workspaces/${encodeURIComponent(params.workspaceId)}/preview/open`;
  form.style.display = "none";

  const pathInput = params.documentRef.createElement("input");
  pathInput.type = "hidden";
  pathInput.name = "path";
  pathInput.value = params.path;
  form.appendChild(pathInput);

  let appended = false;
  try {
    params.documentRef.body.appendChild(form);
    appended = true;
    form.submit();
  } finally {
    if (appended) params.documentRef.body.removeChild(form);
  }
}
