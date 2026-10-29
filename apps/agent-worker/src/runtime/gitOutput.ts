import { StringDecoder } from "node:string_decoder";

export const GIT_RAW_OUTPUT_MAX_BYTES = 512 * 1024;
export const GIT_OUTPUT_HEAD_BYTES = 64 * 1024;
export const GIT_OUTPUT_TAIL_BYTES = 8 * 1024;
export const GIT_OUTPUT_TRUNCATION_MARKER = "\n[output truncated: head/tail retained]\n";
// Both safe summaries, including fixed markers, fit below the combined raw cap.
const REDACTED = "[REDACTED]";
// Match the authority delimiter, not an arbitrarily long scheme that may have
// already crossed the streaming boundary. Harmless over-redaction is safer.
const URL_USERINFO = /(:\/\/)[^\s/?#]*@/g;
const OPEN_URL_AUTHORITY = /:\/\/[^\s/?#]*$/;

function utf8Head(buffer: Buffer, size: number) {
  let end = Math.min(size, buffer.length);
  if (end < buffer.length) while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end);
}

function utf8Tail(buffer: Buffer, size: number) {
  let start = Math.max(0, buffer.length - size);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start);
}

/** Stores only safe, post-redaction bytes; retention never changes matching. */
class SafeOutputWindow {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private bytes = 0;
  private headFull = false;

  write(text: string) {
    if (!text) return;
    const bytes = Buffer.from(text, "utf8");
    const previous = this.bytes;
    this.bytes += bytes.length;
    if (!this.headFull) {
      const remaining = GIT_OUTPUT_HEAD_BYTES - this.head.length;
      const piece = utf8Head(bytes, remaining);
      this.head = Buffer.concat([this.head, piece]);
      // A code point straddling the head cap belongs to the safe tail, not a
      // replacement character or a partial code point in the retained head.
      if (piece.length < bytes.length) this.tail = Buffer.from(utf8Tail(bytes.subarray(piece.length), GIT_OUTPUT_TAIL_BYTES));
      if (bytes.length >= remaining) this.headFull = true;
    } else {
      this.tail = Buffer.from(utf8Tail(Buffer.concat([this.tail, bytes]), GIT_OUTPUT_TAIL_BYTES));
    }
    if (previous < GIT_OUTPUT_HEAD_BYTES && this.bytes > GIT_OUTPUT_HEAD_BYTES && this.tail.length === 0) {
      this.tail = Buffer.from(utf8Tail(bytes, GIT_OUTPUT_TAIL_BYTES));
    }
  }

  text() {
    if (this.bytes <= GIT_OUTPUT_HEAD_BYTES) return this.head.toString("utf8");
    if (this.bytes <= this.head.length + this.tail.length) return Buffer.concat([this.head, this.tail]).toString("utf8");
    return `${this.head.toString("utf8")}${GIT_OUTPUT_TRUNCATION_MARKER}${this.tail.toString("utf8")}`;
  }
}

/** Linear prefix/suffix matching prevents quadratic work for a 1 MiB key. */
function unfinishedKnownSuffix(text: string, pattern: string) {
  const prefix = new Uint32Array(pattern.length);
  for (let i = 1, j = 0; i < pattern.length; i++) {
    while (j > 0 && pattern[i] !== pattern[j]) j = prefix[j - 1];
    if (pattern[i] === pattern[j]) j++;
    prefix[i] = j;
  }
  let matched = 0;
  const tail = text.slice(-pattern.length);
  for (let i = 0; i < tail.length; i++) {
    const char = tail[i];
    while (matched > 0 && char !== pattern[matched]) matched = prefix[matched - 1];
    if (char === pattern[matched]) matched++;
    if (matched === pattern.length) matched = prefix[matched - 1];
  }
  return matched;
}

class StreamOutputFilter {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private window = new SafeOutputWindow();
  private finished = false;
  private readonly hold: number;
  redacted = false;

  constructor(private readonly patterns: string[]) {
    this.hold = Math.max(32, ...patterns.map((value) => value.length - 1));
  }

  write(chunk: Buffer) {
    this.pending += this.decoder.write(chunk);
    this.flush(false);
  }

  private flush(final: boolean, incomplete = false) {
    let boundary = final ? this.pending.length : Math.max(0, this.pending.length - this.hold);
    if (!final) {
      const openUrl = OPEN_URL_AUTHORITY.exec(this.pending);
      if (openUrl) boundary = Math.min(boundary, openUrl.index);
      // Do not split a UTF-16 surrogate pair when handing safe text to Buffer.
      const last = this.pending.charCodeAt(boundary - 1);
      if (last >= 0xd800 && last <= 0xdbff) boundary--;
    }
    let consumed = 0;
    while (consumed < boundary) {
      let index = this.pending.length;
      let length = 0;
      let replacement = REDACTED;
      for (const pattern of this.patterns) {
        const found = this.pending.indexOf(pattern, consumed);
        if (found >= 0 && (found < index || (found === index && pattern.length > length))) {
          index = found;
          length = pattern.length;
        }
      }
      URL_USERINFO.lastIndex = consumed;
      const url = URL_USERINFO.exec(this.pending);
      if (url && (url.index < index || (url.index === index && url[0].length > length))) {
        index = url.index;
        length = url[0].length;
        replacement = `${url[1]}${REDACTED}@`;
      }
      if (index >= boundary) {
        const unmatched = this.pending.slice(consumed, boundary);
        let removed = 0;
        if (final && incomplete) {
          for (const pattern of this.patterns) removed = Math.max(removed, unfinishedKnownSuffix(unmatched, pattern));
          const openUrl = OPEN_URL_AUTHORITY.exec(unmatched);
          if (openUrl) removed = Math.max(removed, unmatched.length - openUrl.index);
        }
        this.window.write(removed ? unmatched.slice(0, -removed) : unmatched);
        if (removed) {
          this.window.write(REDACTED);
          this.redacted = true;
        }
        consumed = boundary;
        break;
      }
      this.window.write(this.pending.slice(consumed, index));
      this.window.write(replacement);
      this.redacted = true;
      consumed = index + length;
    }
    this.pending = this.pending.slice(consumed);
  }

  finish(incomplete: boolean) {
    if (this.finished) return this.window.text();
    this.finished = true;
    // A byte-budget or forced-close cut must not append an incomplete UTF-8
    // character that would obscure a known-secret suffix from the matcher.
    const end = this.decoder.end();
    if (!incomplete) this.pending += end;
    this.flush(true, incomplete);
    return this.window.text();
  }
}

/** Raw bytes are budgeted before replacement; overflowing chunks are still drained. */
export class GitOutputGuard {
  private readonly stdout: StreamOutputFilter;
  private readonly stderr: StreamOutputFilter;
  private capturedBytes = 0;
  outputLimitExceeded = false;

  constructor(knownValues: readonly string[], private readonly rawLimit = GIT_RAW_OUTPUT_MAX_BYTES) {
    const patterns = [...new Set(knownValues.filter((value) => value.length > 0))].sort((a, b) => b.length - a.length);
    this.stdout = new StreamOutputFilter(patterns);
    this.stderr = new StreamOutputFilter(patterns);
  }

  write(stream: "stdout" | "stderr", chunk: Buffer) {
    const remain = Math.max(0, this.rawLimit - this.capturedBytes);
    const accepted = chunk.subarray(0, remain);
    this.capturedBytes += accepted.length;
    // Draining after the raw cap must not repeatedly rescan a held authority or
    // secret suffix when no new bytes were accepted.
    if (accepted.length > 0) this[stream].write(accepted);
    if (accepted.length < chunk.length) this.outputLimitExceeded = true;
    return this.outputLimitExceeded;
  }

  finish(incomplete = false) {
    const stdout = this.stdout.finish(incomplete || this.outputLimitExceeded);
    const stderr = this.stderr.finish(incomplete || this.outputLimitExceeded);
    return { stdout, stderr, outputRedacted: this.stdout.redacted || this.stderr.redacted };
  }
}
