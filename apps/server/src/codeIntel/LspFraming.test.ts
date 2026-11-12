import { describe, expect, it } from "@effect/vitest";

import { encodeLspMessage, makeLspFrameDecoder } from "./LspFraming.ts";

const frame = (body: string) =>
  Buffer.concat([
    Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`, "ascii"),
    Buffer.from(body, "utf8"),
  ]);

describe("LspFraming", () => {
  it("counts the length in bytes, not characters", () => {
    const encoded = Buffer.from(encodeLspMessage({ text: "héllo ✓" }));
    const body = JSON.stringify({ text: "héllo ✓" });
    expect(encoded.toString("ascii", 0, encoded.indexOf("\r\n"))).toBe(
      `Content-Length: ${Buffer.byteLength(body)}`,
    );
    expect(Buffer.byteLength(body)).toBeGreaterThan(body.length);

    const decoded = makeLspFrameDecoder().push(encoded);
    expect(decoded).toEqual({ _tag: "bodies", bodies: [body] });
  });

  it("returns several bodies from one chunk, in order", () => {
    const decoded = makeLspFrameDecoder().push(Buffer.concat([frame("{}"), frame("[1]")]));
    expect(decoded).toEqual({ _tag: "bodies", bodies: ["{}", "[1]"] });
  });

  it("waits for the rest of a body split across chunks, even mid-character", () => {
    const decoder = makeLspFrameDecoder();
    const whole = frame('"✓"');
    const cut = whole.length - 3;
    expect(decoder.push(whole.subarray(0, cut))).toEqual({ _tag: "bodies", bodies: [] });
    expect(decoder.push(whole.subarray(cut))).toEqual({ _tag: "bodies", bodies: ['"✓"'] });
  });

  it("waits for the rest of a header split across chunks", () => {
    const decoder = makeLspFrameDecoder();
    const whole = frame("{}");
    expect(decoder.push(whole.subarray(0, 5))).toEqual({ _tag: "bodies", bodies: [] });
    expect(decoder.push(whole.subarray(5))).toEqual({ _tag: "bodies", bodies: ["{}"] });
  });

  it("accepts the header in any case and with other headers beside it", () => {
    const body = "{}";
    const decoded = makeLspFrameDecoder().push(
      Buffer.from(
        `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length:   2\r\n\r\n${body}`,
      ),
    );
    expect(decoded).toEqual({ _tag: "bodies", bodies: [body] });
  });

  it("keeps decoding after a body that ends exactly at the chunk", () => {
    const decoder = makeLspFrameDecoder();
    expect(decoder.push(frame("{}"))).toEqual({ _tag: "bodies", bodies: ["{}"] });
    expect(decoder.push(frame("[]"))).toEqual({ _tag: "bodies", bodies: ["[]"] });
  });

  it("fails a header without Content-Length", () => {
    expect(makeLspFrameDecoder().push(Buffer.from("X-Other: 1\r\n\r\n{}"))).toEqual({
      _tag: "failure",
      failure: "missing_content_length",
    });
  });

  it("fails a Content-Length that is not a number", () => {
    expect(makeLspFrameDecoder().push(Buffer.from("Content-Length: abc\r\n\r\n{}"))).toEqual({
      _tag: "failure",
      failure: "missing_content_length",
    });
  });

  it("fails a header that never ends instead of buffering it", () => {
    expect(makeLspFrameDecoder().push(Buffer.alloc(9 * 1024, "a"))).toEqual({
      _tag: "failure",
      failure: "header_too_large",
    });
  });

  it("fails a message over the limit before reading its body", () => {
    const decoder = makeLspFrameDecoder(10);
    expect(decoder.push(Buffer.from("Content-Length: 11\r\n\r\n"))).toEqual({
      _tag: "failure",
      failure: "message_too_large",
    });
    expect(makeLspFrameDecoder(10).push(frame("0123456789"))).toEqual({
      _tag: "bodies",
      bodies: ["0123456789"],
    });
  });
});
