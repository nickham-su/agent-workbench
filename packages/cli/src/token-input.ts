import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { CliError } from "./errors.js";

export interface TokenInput extends Readable {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

export interface CliIO {
  stdin: TokenInput;
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable;
}

const MAX_TOKEN_BYTES = 64 * 1024;

function validateToken(token: string): string {
  if (!token || token.includes("\r") || token.includes("\n") || Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
    throw new CliError(2, "登录 token 必须是非空 UTF-8 单行，内容不得超过 64 KiB。");
  }
  return token;
}

export async function readStdinToken(stdin: TokenInput): Promise<string> {
  if (stdin.isTTY) throw new CliError(2, "--token-stdin 需要非交互标准输入，请使用管道。");
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      // The maximum valid content may be followed by one CRLF.
      if (bytes > MAX_TOKEN_BYTES + 2) throw new Error("Input too large");
      chunks.push(buffer);
    }
    let token = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
    if (token.endsWith("\r\n")) token = token.slice(0, -2);
    else if (token.endsWith("\n")) token = token.slice(0, -1);
    return validateToken(token);
  } catch {
    throw new CliError(2, "无法读取有效 token；输入必须是非空 UTF-8 单行且内容不超过 64 KiB。");
  }
}

export async function readHiddenToken(io: CliIO): Promise<string> {
  const { stdin, stdout, stderr } = io;
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) {
    throw new CliError(2, "认证已开启；非交互登录必须指定 --token-stdin。");
  }
  return new Promise<string>((resolve, reject) => {
    const previousRaw = Boolean(stdin.isRaw);
    const wasFlowing = stdin.readableFlowing === true;
    const decoder = new StringDecoder("utf8");
    let token = "";
    let settled = false;
    const finish = (error?: CliError) => {
      if (settled) return;
      settled = true;
      stdin.off("data", onData);
      stdin.off("end", onCancel);
      stdin.off("close", onCancel);
      stdin.off("error", onCancel);
      try { stdin.setRawMode!(previousRaw); } catch { /* Best-effort terminal restoration. */ }
      // A fresh process.stdin has readableFlowing=null, not isPaused()=true.
      // Leaving it resumed would keep a completed interactive CLI alive.
      if (!wasFlowing) stdin.pause();
      stderr.write("\n");
      if (error) reject(error);
      else {
        try { resolve(validateToken(token)); }
        catch { reject(new CliError(2, "登录 token 必须是非空单行且内容不超过 64 KiB。")); }
      }
    };
    const onCancel = () => finish(new CliError(2, "登录输入已取消，未保存配置。"));
    const onData = (data: Buffer | string) => {
      const decoded = typeof data === "string" ? data : decoder.write(data);
      for (const character of decoded) {
        if (character === "\u0003" || character === "\u0004" || character === "\u001b") return onCancel();
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") token = Array.from(token).slice(0, -1).join("");
        else token += character;
        if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
          return finish(new CliError(2, "登录 token 内容不得超过 64 KiB。"));
        }
      }
    };
    try {
      stdin.setRawMode!(true);
      stdin.on("data", onData);
      stdin.once("end", onCancel);
      stdin.once("close", onCancel);
      stdin.once("error", onCancel);
      stderr.write("登录 token（输入隐藏，Ctrl+C 取消）：");
      stdin.resume();
    } catch {
      finish(new CliError(2, "无法启用隐藏输入，请使用 --token-stdin。"));
    }
  });
}

export function readLoginToken(io: CliIO, tokenStdin: boolean): Promise<string> {
  return tokenStdin ? readStdinToken(io.stdin) : readHiddenToken(io);
}
