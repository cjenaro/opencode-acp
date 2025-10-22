import { describe, it, expect } from "bun:test";
import { promptToOpencode } from "../src/converters";

describe("converters", () => {
  describe("promptToOpencode", () => {
    it("should convert text chunks", () => {
      const result = promptToOpencode({
        sessionId: "test",
        prompt: [{ type: "text", text: "Hello world" }],
      } as any);

      expect(result).toEqual([{ type: "text", text: "Hello world" }]);
    });
  });
});
