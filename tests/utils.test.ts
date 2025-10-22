import { describe, it, expect } from "bun:test";
import { unreachable } from "../src/utils";

describe("utils", () => {
  describe("unreachable", () => {
    it("should throw an error", () => {
      expect(() => unreachable("test" as never)).toThrow();
    });
  });
});
