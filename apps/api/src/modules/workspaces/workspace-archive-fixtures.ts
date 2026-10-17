/** Tiny, deterministic raw fixtures: tests never invoke system archivers or read user packages. */
import { deflateRawSync } from "node:zlib";
import { createRequire } from "node:module";
const crc32: typeof import("buffer-crc32") = createRequire(import.meta.url)("buffer-crc32");

export type ZipFixtureEntry = {
  name: string | Buffer;
  data?: string | Buffer;
  method?: number;
  flags?: number;
  mode?: number;
  unix?: boolean;
  crc?: number;
  size?: number;
  zip64Size?: bigint;
  unicodeName?: string;
  extra?: Buffer;
  comment?: Buffer;
  mtime?: Date;
};

function extraField(id: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0); header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}

export function zipFixture(entries: ZipFixtureEntry[], comment = Buffer.alloc(0), zip64End = false): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? "");
    const method = entry.method ?? 0;
    const checksum = entry.crc ?? crc32.unsigned(data);
    const flags = entry.flags ?? (Buffer.isBuffer(entry.name) ? 0 : 0x800);
    const compressedData = method === 8 ? deflateRawSync(data) : data;
    const dosTime = entry.mtime ? (entry.mtime.getUTCHours() << 11) | (entry.mtime.getUTCMinutes() << 5) | (entry.mtime.getUTCSeconds() >> 1) : 0;
    const dosDate = entry.mtime ? ((entry.mtime.getUTCFullYear() - 1980) << 9) | ((entry.mtime.getUTCMonth() + 1) << 5) | entry.mtime.getUTCDate() : 0;
    const compressed = flags & 1 ? Buffer.concat([Buffer.alloc(12), compressedData]) : compressedData;
    let extra = entry.extra ?? Buffer.alloc(0);
    if (entry.unicodeName !== undefined) {
      const text = Buffer.alloc(5);
      text[0] = 1; text.writeUInt32LE(crc32.unsigned(name), 1);
      extra = Buffer.concat([extra, extraField(0x7075, Buffer.concat([text, Buffer.from(entry.unicodeName)]))]);
    }
    const zip64 = entry.zip64Size !== undefined;
    if (zip64) {
      const sizes = Buffer.alloc(16);
      sizes.writeBigUInt64LE(entry.zip64Size!, 0); sizes.writeBigUInt64LE(BigInt(compressed.length), 8);
      extra = Buffer.concat([extra, extraField(1, sizes)]);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(checksum, 14);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(zip64 ? 0xffffffff : compressed.length, 18);
    local.writeUInt32LE(zip64 ? 0xffffffff : (entry.size ?? data.length), 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    const packed = Buffer.concat([local, name, extra, compressed]);
    locals.push(packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.unix === false ? 20 : 0x314, 4); central.writeUInt16LE(zip64 ? 45 : 20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(checksum, 16);
    central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(zip64 ? 0xffffffff : compressed.length, 20);
    central.writeUInt32LE(zip64 ? 0xffffffff : (entry.size ?? data.length), 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30);
    central.writeUInt16LE(entry.comment?.length ?? 0, 32);
    central.writeUInt32LE(((entry.mode ?? (name[name.length - 1] === 47 ? 0o040755 : 0o100644)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name, extra, entry.comment ?? Buffer.alloc(0)]));
    offset += packed.length;
  }
  const directory = Buffer.concat(centrals);
  if (zip64End) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0); record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24); record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40); record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10);
    end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16); end.writeUInt16LE(comment.length, 20);
    return Buffer.concat([...locals, directory, record, locator, end, comment]);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, directory, end, comment]);
}

export type TarFixtureEntry = {
  name: string;
  data?: string | Buffer;
  type?: string;
  size?: number;
  mode?: number;
  link?: string;
  badChecksum?: boolean;
  uid?: number;
  gid?: number;
  mtime?: number;
};

export function tarFixture(entries: TarFixtureEntry[], footer = true): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    const header = Buffer.alloc(512);
    const octal = (value: number, at: number, len: number) => header.write(value.toString(8).padStart(len - 1, "0") + "\0", at, len, "ascii");
    header.write(entry.name, 0, 100, "utf8"); octal(entry.mode ?? 0o644, 100, 8);
    octal(entry.uid ?? 123, 108, 8); octal(entry.gid ?? 456, 116, 8);
    octal(entry.size ?? data.length, 124, 12); octal(entry.mtime ?? 1, 136, 12);
    header.fill(32, 148, 156); header.write(entry.type ?? "0", 156, 1, "ascii");
    if (entry.link) header.write(entry.link, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
    const sum = header.reduce((total, byte) => total + byte, 0) + (entry.badChecksum ? 1 : 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  if (footer) chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

export function paxFixture(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => {
    const body = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(body) + 1;
    while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
    return String(length) + body;
  }).join("");
}
