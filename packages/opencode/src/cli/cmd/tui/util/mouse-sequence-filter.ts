const COMPLETE_SGR_MOUSE_RE = /^(?:\x1b\[<|\[<)\d+;\d+;\d+[Mm]$/
const COMPLETE_RXVT_MOUSE_RE = /^(?:\x1b\[|\[)\d+;\d+;\d+M$/
const PARTIAL_SGR_MOUSE_RE = /^(?:\x1b\[<|\[<)[\d;]*$/
const MOUSE_BURST_CHARS_RE = /^[\d;Mm<]+$/

function isPartialRxvtMouseSequence(sequence: string) {
  const match = sequence.match(/^(?:\x1b\[|\[)([\d;]*)$/)
  if (!match) return false

  const body = match[1]
  if (!body) return true

  const firstField = body.split(";", 1)[0]
  if (!firstField) return true
  if (firstField.length === 1) return firstField >= "3"

  return Number(firstField) >= 32
}

export function createMouseSequenceFilter(input?: {
  now?: () => number
  maxFragmentAgeMs?: number
}) {
  const now = input?.now ?? Date.now
  const maxFragmentAgeMs = input?.maxFragmentAgeMs ?? 100

  let pending = ""
  let pendingSince = 0
  let recentEscapeSince = 0
  let mouseBurstArmedSince = 0

  function clearPending() {
    pending = ""
    pendingSince = 0
  }

  function armMouseBurst(nowMs: number) {
    mouseBurstArmedSince = nowMs
  }

  function hasRecentEscape(nowMs: number) {
    return recentEscapeSince > 0 && nowMs - recentEscapeSince <= maxFragmentAgeMs
  }

  function hasArmedMouseBurst(nowMs: number) {
    return mouseBurstArmedSince > 0 && nowMs - mouseBurstArmedSince <= maxFragmentAgeMs
  }

  function isCompleteMouseSequence(sequence: string) {
    return COMPLETE_SGR_MOUSE_RE.test(sequence) || COMPLETE_RXVT_MOUSE_RE.test(sequence)
  }

  function isPartialMouseSequence(sequence: string) {
    return PARTIAL_SGR_MOUSE_RE.test(sequence) || isPartialRxvtMouseSequence(sequence)
  }

  function isLikelyMouseBurstChunk(sequence: string) {
    return MOUSE_BURST_CHARS_RE.test(sequence) && /[Mm]/.test(sequence)
  }

  // Swallow malformed mouse fragments so they do not end up in the prompt input.
  return (sequence: string) => {
    if (!sequence) return false

    const nowMs = now()
    if (sequence === "\x1b") {
      recentEscapeSince = nowMs
      return false
    }

    if (pending && nowMs - pendingSince > maxFragmentAgeMs) {
      clearPending()
    }

    if (isCompleteMouseSequence(sequence)) {
      clearPending()
      armMouseBurst(nowMs)
      return true
    }

    if (pending) {
      const candidate = pending + sequence
      if (isCompleteMouseSequence(candidate)) {
        clearPending()
        armMouseBurst(nowMs)
        return true
      }
      if (isPartialMouseSequence(candidate)) {
        pending = candidate
        pendingSince = nowMs
        armMouseBurst(nowMs)
        return true
      }
      if (isLikelyMouseBurstChunk(sequence)) {
        clearPending()
        armMouseBurst(nowMs)
        return true
      }
      clearPending()
    }

    if (hasArmedMouseBurst(nowMs) && isLikelyMouseBurstChunk(sequence)) {
      armMouseBurst(nowMs)
      return true
    }

    if (sequence === "\x1b[" || sequence === "\x1b[<") {
      pending = sequence
      pendingSince = nowMs
      if (sequence === "\x1b[<") armMouseBurst(nowMs)
      return true
    }

    if (hasRecentEscape(nowMs) && (sequence === "[" || sequence === "[<")) {
      pending = sequence
      pendingSince = nowMs
      if (sequence === "[<") armMouseBurst(nowMs)
      return true
    }

    return false
  }
}
