import type { ToolPromptProjector } from "./types.js";

export const writeToolPromptProjector: ToolPromptProjector = {
  projectCallInput(args) {
    return args;
  },
  projectResult(result) {
    return result;
  }
};
