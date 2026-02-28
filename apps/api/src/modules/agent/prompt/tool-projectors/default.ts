import type { ToolPromptProjector } from "./types.js";

export const defaultToolPromptProjector: ToolPromptProjector = {
  projectCallInput(args) {
    return args;
  },
  projectResult(result) {
    return result;
  }
};
