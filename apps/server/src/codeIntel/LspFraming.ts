/** LSP's base protocol: `Content-Length: <bytes>\r\n\r\n<JSON>`. The length counts bytes, not characters. */

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");
const MAX_HEADER_BYTES = 8 * 1024;
// The largest real answer measured is under 1 MB; a body is parsed whole in the server's process.
export const MAX_LSP_MESSAGE_BYTES = 16 * 1024 * 1024;

export type LspFramingFailure = "header_too_large" | "missing_content_length" | "message_too_large";

export function encodeLspMessage(message: unknown): Uint8Array {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

export interface LspFrameDecoder {
  /** Bodies completed by this chunk, in order. After a failure the stream cannot be resynchronized. */
  readonly push: (
    chunk: Uint8Array,
  ) =>
    | { readonly _tag: "bodies"; readonly bodies: ReadonlyArray<string> }
    | { readonly _tag: "failure"; readonly failure: LspFramingFailure };
}

export function makeLspFrameDecoder(maxMessageBytes = MAX_LSP_MESSAGE_BYTES): LspFrameDecoder {
  let buffered = Buffer.alloc(0);
  let bodyLength: number | undefined;

  return {
    push: (chunk) => {
      buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk]);
      const bodies: Array<string> = [];
      for (;;) {
        if (bodyLength === undefined) {
          const headerEnd = buffered.indexOf(HEADER_SEPARATOR);
          if (headerEnd < 0) {
            return buffered.length > MAX_HEADER_BYTES
              ? { _tag: "failure", failure: "header_too_large" }
              : { _tag: "bodies", bodies };
          }
          const match = /^content-length:[ \t]*(\d+)[ \t]*$/im.exec(
            buffered.subarray(0, headerEnd).toString("ascii"),
          );
          if (match === null) return { _tag: "failure", failure: "missing_content_length" };
          const length = Number(match[1]);
          if (length > maxMessageBytes) return { _tag: "failure", failure: "message_too_large" };
          bodyLength = length;
          buffered = buffered.subarray(headerEnd + HEADER_SEPARATOR.length);
        }
        if (buffered.length < bodyLength) return { _tag: "bodies", bodies };
        bodies.push(buffered.subarray(0, bodyLength).toString("utf8"));
        buffered = buffered.subarray(bodyLength);
        bodyLength = undefined;
      }
    },
  };
}
