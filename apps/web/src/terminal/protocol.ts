export type WsClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type WsServerMessage =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number }
  | { type: "error"; message: string };

