import type { SessionStatus } from "@opencode-ai/sdk/v2"

export type KeyboardEventLike = {
  ctrl?: boolean
  name?: string
}

export function isCtrlCKeyEvent(evt: KeyboardEventLike | undefined): boolean {
  return Boolean(evt?.ctrl && evt?.name === "c")
}

export function getRunningSessionIDs(
  statuses: Record<string, SessionStatus | undefined> | undefined,
): string[] {
  if (!statuses) return []

  return Object.entries(statuses)
    .filter(([, status]) => status && status.type !== "idle")
    .map(([sessionID]) => sessionID)
}
