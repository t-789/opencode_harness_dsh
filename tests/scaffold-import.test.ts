import { expect, test } from "bun:test"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"

test("opencode plugin + zod importable", () => {
  expect(typeof tool).toBe("function")
  expect(z.string().safeParse("x").success).toBe(true)
})
