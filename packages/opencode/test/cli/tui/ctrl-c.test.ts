import { describe, expect, test } from "bun:test"
import { getRunningSessionIDs, isCtrlCKeyEvent } from "../../../src/cli/cmd/tui/util/ctrl-c"

describe("tui ctrl-c helpers", () => {
  test("detects raw ctrl-c key events", () => {
    expect(isCtrlCKeyEvent({ ctrl: true, name: "c" })).toBe(true)
    expect(isCtrlCKeyEvent({ ctrl: false, name: "c" })).toBe(false)
    expect(isCtrlCKeyEvent({ ctrl: true, name: "d" })).toBe(false)
    expect(isCtrlCKeyEvent(undefined)).toBe(false)
  })

  test("returns only non-idle session ids", () => {
    expect(
      getRunningSessionIDs({
        idle: { type: "idle" } as any,
        loading: { type: "loading" } as any,
        responding: { type: "running" } as any,
        missing: undefined,
      }),
    ).toEqual(["loading", "responding"])
  })
})
