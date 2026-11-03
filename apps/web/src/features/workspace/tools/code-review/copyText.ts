import { message } from "ant-design-vue";

export async function copyTextWithFeedback(content: string, successMessage: string, failureMessage: string) {
  if (!content) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
      message.success(successMessage);
      return;
    }
  } catch {
    // Clipboard access can be unavailable outside a secure context; try the fallback.
  }

  const textarea = document.createElement("textarea");
  try {
    textarea.value = content;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    if (document.execCommand("copy")) {
      message.success(successMessage);
      return;
    }
  } catch {
    // Report one failure after both clipboard strategies have been attempted.
  } finally {
    textarea.remove();
  }
  message.error(failureMessage);
}
