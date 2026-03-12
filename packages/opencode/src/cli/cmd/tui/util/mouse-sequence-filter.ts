const COMPLETE_SGR_MOUSE_RE = /^(?:\x1b\[<|\[<)\d+;\d+;\d+[Mm]$/
const COMPLETE_RXVT_MOUSE_RE = /^(?:\x1b\[|\[)\d+;\d+;\d+M$/
const PARTIAL_SGR_MOUSE_RE = /^(?:\x1b\[<|\[<)[\d;]*$/

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

  function clearPending() {
    pending = ""
    pendingSince = 0
  }

  function isCompleteMouseSequence(sequence: string) {
    return COMPLETE_SGR_MOUSE_RE.test(sequence) || COMPLETE_RXVT_MOUSE_RE.test(sequence)
  }

  function isPartialMouseSequence(sequence: string) {
    return PARTIAL_SGR_MOUSE_RE.test(sequence) || isPartialRxvtMouseSequence(sequence)
  }

  // Swallow malformed mouse fragments so they do not end up in the prompt input.
  return (sequence: string) => {
    if (!sequence) return false

    const nowMs = now()
    if (pending && nowMs - pendingSince > maxFragmentAgeMs) {
      clearPending()
    }

    if (isCompleteMouseSequence(sequence)) {
      clearPending()
      return true
    }

    if (pending) {
      const candidate = pending + sequence
      if (isCompleteMouseSequence(candidate)) {
        clearPending()
        return true
      }
      if (isPartialMouseSequence(candidate)) {
        pending = candidate
        pendingSince = nowMs
        return true
      }
      clearPending()
    }

    if (sequence === "\x1b[" || sequence === "\x1b[<" || sequence === "[" || sequence === "[<") {
      pending = sequence
      pendingSince = nowMs
      return true
    }

    return false
  }
}
