import assert from "node:assert/strict";
import test from "node:test";

import { divide } from "../src/divide.ts";

test("divides two numbers", () => {
  assert.equal(divide(6, 3), 2);
});
