import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canOpenWorkspacePreview,
  getWorkspacePreviewTarget,
  openWorkspacePreview,
  type PreviewDocument,
  type PreviewFormElement,
  type PreviewInputElement
} from "./preview";

type Node = { data: { kind: string; path: string } };

function node(kind: string, path: string): Node {
  return { data: { kind, path } };
}

function fakeDocument(options: { submitThrows?: boolean } = {}) {
  const events: string[] = [];
  const inputs: PreviewInputElement[] = [];
  let appendedForm: PreviewFormElement | null = null;
  const form: PreviewFormElement = {
    method: "",
    target: "",
    action: "",
    style: { display: "" },
    appendChild(input) {
      events.push("form.appendChild");
      inputs.push(input);
    },
    submit() {
      events.push("form.submit");
      if (options.submitThrows) throw new Error("submit failed");
    }
  };
  function createElement(tagName: "form"): PreviewFormElement;
  function createElement(tagName: "input"): PreviewInputElement;
  function createElement(tagName: "form" | "input"): PreviewFormElement | PreviewInputElement {
    if (tagName === "form") return form;
    return { type: "", name: "", value: "" };
  }
  const documentRef: PreviewDocument = {
    createElement,
    body: {
      appendChild(child) {
        events.push("body.appendChild");
        appendedForm = child;
      },
      removeChild(child) {
        events.push("body.removeChild");
        assert.equal(child, appendedForm);
        appendedForm = null;
      }
    }
  };
  return { documentRef, form, inputs, events, get appendedForm() { return appendedForm; } };
}

test("preview visibility follows the shared entry catalog and never exposes directories or disabled preview", () => {
  const visiblePaths = ["page.html", "page.HTM", "images/photo.PNG", "icon.SvG", "audio/track.MP3", "video/clip.WebM"];
  for (const path of visiblePaths) {
    assert.equal(canOpenWorkspacePreview({ previewEnabled: true, node: node("file", path) }), true, path);
  }

  for (const candidate of [
    node("file", "styles.css"),
    node("file", "main.JS"),
    node("file", "module.mjs"),
    node("file", "font.WOFF2"),
    node("dir", "media"),
    node("dir", "page.html"),
    null
  ]) {
    assert.equal(canOpenWorkspacePreview({ previewEnabled: true, node: candidate }), false);
  }
  assert.equal(canOpenWorkspacePreview({ previewEnabled: false, node: node("file", "page.html") }), false);
});

test("preview form targets only the same-origin main open endpoint and cleans up after submit", () => {
  const fake = fakeDocument();
  openWorkspacePreview({ workspaceId: "team/a b?", path: "assets/封面 image.PNG", documentRef: fake.documentRef });

  assert.equal(fake.form.method, "post");
  assert.equal(fake.form.target, "_blank");
  assert.equal(fake.form.action, "/api/workspaces/team%2Fa%20b%3F/preview/open");
  assert.equal(fake.form.style.display, "none");
  assert.deepEqual(fake.inputs, [{ type: "hidden", name: "path", value: "assets/封面 image.PNG" }]);
  assert.deepEqual(fake.events, ["form.appendChild", "body.appendChild", "form.submit", "body.removeChild"]);
  assert.equal(fake.appendedForm, null);
});

test("preview form is removed even when synchronous submit fails", () => {
  const fake = fakeDocument({ submitThrows: true });
  assert.throws(
    () => openWorkspacePreview({ workspaceId: "workspace", path: "page.html", documentRef: fake.documentRef }),
    /submit failed/
  );
  assert.deepEqual(fake.events, ["form.appendChild", "body.appendChild", "form.submit", "body.removeChild"]);
  assert.equal(fake.appendedForm, null);
});

test("preview action uses the node selected at click time rather than a previous selection", () => {
  const oldNode = node("file", "old.html");
  const currentNode = node("file", "media/current.MP4");
  assert.equal(getWorkspacePreviewTarget({ previewEnabled: true, node: oldNode }), "old.html");
  assert.equal(getWorkspacePreviewTarget({ previewEnabled: true, node: currentNode }), "media/current.MP4");
  assert.equal(getWorkspacePreviewTarget({ previewEnabled: true, node: node("dir", "media") }), null);
  assert.equal(getWorkspacePreviewTarget({ previewEnabled: false, node: currentNode }), null);
});
