import { describe, it, expect } from "vitest";
import { allowedUrl, Input, Empty } from "./index.js";
import { Value } from "@sinclair/typebox/value";
describe("trust boundaries", () => {
  it("only exact HTTPS origins", () => {
    expect(allowedUrl("https://example.com/")).toBe(true);
    for (const u of [
      "http://example.com",
      "https://example.com.evil.test",
      "https://127.0.0.1",
      "https://user@example.com",
      "file:///etc/passwd",
      "https://example.com:444",
    ])
      expect(allowedUrl(u)).toBe(false);
  });
  it("rejects untyped commands and bounds", () => {
    expect(Value.Check(Empty, { ownerId: "attacker" })).toBe(false);
    expect(Value.Check(Input, { type: "text", text: "hello" })).toBe(true);
    for (const a of [
      { type: "eval", code: "1" },
      { type: "mouseMove", x: 1280, y: 0 },
      { type: "text", text: "a", ownerId: "x" },
      { type: "keyPress", key: "F12" },
    ])
      expect(Value.Check(Input, a)).toBe(false);
  });
});
