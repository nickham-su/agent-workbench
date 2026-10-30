import type { Command, Option } from "commander";

export interface ArgumentInspection { command: Command; json: boolean; help: boolean; invalid: boolean; duplicate: boolean; }
/** Follow the registered grammar, consuming option values rather than scanning raw strings. */
export function inspectArguments(args: readonly string[], root: Command): ArgumentInspection {
  let command = root;
  let json = false;
  let help = false;
  let invalid = false;
  let duplicate = false;
  const seen = new Set<string>();
  function findOption(flag: string): Option | undefined {
    for (let current: Command | null = command; current; current = current.parent) {
      const found = current.options.find((option) => option.short === flag || option.long === flag);
      if (found) return found;
    }
    return undefined;
  }
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === "--help" || argument === "-h") { help = true; continue; }
    if (argument.startsWith("-")) {
      const equals = argument.indexOf("=");
      const flag = equals < 0 ? argument : argument.slice(0, equals);
      let option = findOption(flag);
      let attachedShort = false;
      if (!option && /^-[^-].+/.test(argument)) {
        option = findOption(argument.slice(0, 2));
        attachedShort = Boolean(option?.required);
        if (!attachedShort) option = undefined;
      }
      if (!option) { invalid = true; continue; }
      const key = option.attributeName();
      if (key === "json") json = true;
      if (seen.has(key) && key !== "image") duplicate = true;
      seen.add(key);
      if (option.required && equals < 0 && !attachedShort) {
        if (args[i + 1] !== "--help" && args[i + 1] !== "-h") i++;
      }
      continue;
    }
    const child = command.commands.find((candidate) => candidate.name() === argument);
    if (child) command = child;
    else invalid = true;
  }
  return { command, json, help, invalid, duplicate };
}
export function commandName(command: Command): string {
  const parts: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) parts.unshift(current.name());
  return parts.join(" ");
}
