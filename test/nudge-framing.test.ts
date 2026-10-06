import { test, expect, describe } from "bun:test";
import { normalizeBody } from "../src/daemon/nudge/framing.ts";

describe("normalizeBody (design §10.5)", () => {
  test("every CR/CRLF becomes LF (a CR in the body submits early)", () => {
    expect(normalizeBody("a\r\nb\rc\nd", "claude")).toBe("a\nb\nc\nd");
  });
  test("codex bodies are wrapped in bracketed-paste markers", () => {
    expect(normalizeBody("hi\nthere", "codex")).toBe("\x1b[200~hi\nthere\x1b[201~");
  });
  test("non-codex tools are not wrapped", () => {
    expect(normalizeBody("hi", "claude")).toBe("hi");
    expect(normalizeBody("hi", "copilot")).toBe("hi");
  });
});
