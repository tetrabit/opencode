import { describe, expect, test } from "bun:test"
import { getCtrlCAction, getRunningSessionIDs, isCtrlCKeyEvent } from "../../../src/cli/cmd/tui/util/ctrl-c"

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

  test("exits immediately when ctrl-c is pressed without a running session", () => {
    expect(getCtrlCAction({ armed: false, runningSessionCount: 0 })).toBe("exit")
  })

  test("arms exit after aborting running sessions", () => {
    expect(getCtrlCAction({ armed: false, runningSessionCount: 2 })).toBe("abort-and-arm")
  })

  test("exits on the second ctrl-c while armed", () => {
    expect(getCtrlCAction({ armed: true, runningSessionCount: 1 })).toBe("exit")
  })
})
