// @effect-diagnostics nodeBuiltinImport:off -- fixtures build archives in memory with node's own zlib and hashing.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

const BLOCK = 512;

export interface TarMember {
  readonly name: string;
  readonly content?: string | Uint8Array;
  /** The tar type flag: "0" a file (the default), "5" a directory, "2" a symlink, "x" a pax header. */
  readonly type?: string;
}

const writeField = (header: Uint8Array, offset: number, value: string) =>
  header.set(new TextEncoder().encode(value), offset);

/** A plain ustar archive, which is what the ty release assets hold. */
export const tar = (members: ReadonlyArray<TarMember>): Uint8Array => {
  const blocks: Array<Uint8Array> = [];
  for (const member of members) {
    const content =
      typeof member.content === "string"
        ? new TextEncoder().encode(member.content)
        : (member.content ?? new Uint8Array());
    const header = new Uint8Array(BLOCK);
    writeField(header, 0, member.name);
    writeField(header, 100, "0000755\0");
    writeField(header, 108, "0000000\0");
    writeField(header, 116, "0000000\0");
    writeField(header, 124, `${content.length.toString(8).padStart(11, "0")}\0`);
    writeField(header, 136, "00000000000\0");
    writeField(header, 148, "        ");
    writeField(header, 156, member.type ?? "0");
    writeField(header, 257, "ustar\0");
    writeField(header, 263, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeField(header, 148, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(content.length / BLOCK) * BLOCK);
    padded.set(content);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  const archive = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.length;
  }
  return archive;
};

export const gzip = (bytes: Uint8Array): Uint8Array => NodeZlib.gzipSync(bytes);

export const tarGz = (members: ReadonlyArray<TarMember>): Uint8Array => gzip(tar(members));

export const sha256Hex = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
