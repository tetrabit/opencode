import { describe, expect, test } from "bun:test"
import { createMouseSequenceFilter } from "../../../src/cli/cmd/tui/util/mouse-sequence-filter"

describe("mouse sequence filter", () => {
  test("swallows complete sgr mouse sequences", () => {
    const filter = createMouseSequenceFilter()

    expect(filter("\x1b[<65;174;36M")).toBe(true)
    expect(filter("[<65;174;36m")).toBe(true)
  })

  test("swallows complete rxvt mouse sequences", () => {
    const filter = createMouseSequenceFilter()

    expect(filter("\x1b[65;174;36M")).toBe(true)
    expect(filter("[65;174;36M")).toBe(true)
  })

  test("swallows fragmented mouse sequences after a flushed prefix", () => {
    let now = 0
    const filter = createMouseSequenceFilter({
      now: () => now,
      maxFragmentAgeMs: 100,
    })

    expect(filter("\x1b[")).toBe(true)
    for (const chunk of ["6", "5", ";", "1", "7", "4", ";", "3", "6", "M"]) {
      now += 5
      expect(filter(chunk)).toBe(true)
    }
  })

  test("swallows concatenated mouse burst chunks after a flushed prefix", () => {
    let now = 0
    const filter = createMouseSequenceFilter({
      now: () => now,
      maxFragmentAgeMs: 250,
    })

    expect(filter("\x1b[")).toBe(true)
    now += 10
    expect(filter("5;82;44M5;96;52M172;60M203;59M")).toBe(true)
    now += 10
    expect(filter("206;58M179;61M140;62M104;58M")).toBe(true)
  })

  test("does not swallow normal input after a stale fragment prefix", () => {
    let now = 0
    const filter = createMouseSequenceFilter({
      now: () => now,
      maxFragmentAgeMs: 50,
    })

    expect(filter("\x1b[")).toBe(true)
    now = 100
    expect(filter("h")).toBe(false)
    expect(filter("e")).toBe(false)
  })

  test("does not swallow split non-mouse csi sequences", () => {
    const filter = createMouseSequenceFilter()

    expect(filter("\x1b[")).toBe(true)
    expect(filter("1")).toBe(false)
    expect(filter(";")).toBe(false)
    expect(filter("5")).toBe(false)
    expect(filter("C")).toBe(false)
  })

  test("only treats bare bracket prefixes as mouse-related after a recent escape", () => {
    let now = 1
    const filter = createMouseSequenceFilter({
      now: () => now,
      maxFragmentAgeMs: 50,
    })

    expect(filter("[")).toBe(false)
    expect(filter("\x1b")).toBe(false)
    now += 10
    expect(filter("[")).toBe(true)
  })
})
