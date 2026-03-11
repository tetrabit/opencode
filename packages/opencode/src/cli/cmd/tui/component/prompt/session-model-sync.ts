import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"

const OMO_INTERNAL_INITIATOR_MARKER = "<!-- OMO_INTERNAL_INITIATOR -->"

export function isInternalRuntimeFallbackPrompt(parts: Part[]) {
  return parts.some(
    (part) => part.type === "text" && typeof part.text === "string" && part.text.includes(OMO_INTERNAL_INITIATOR_MARKER),
  )
}

export function getPromptStateFromCompletedAssistant(input: {
  assistant?: AssistantMessage
  user?: UserMessage
  primaryAgents: string[]
}) {
  const assistant = input.assistant
  if (!assistant) return
  if (assistant.time.completed === undefined) return
  if (assistant.error) return
  if (!assistant.agent || !input.primaryAgents.includes(assistant.agent)) return

  const model = {
    providerID: assistant.providerID,
    modelID: assistant.modelID,
  }

  const userMatchesAssistant =
    input.user?.agent === assistant.agent &&
    input.user.model.providerID === model.providerID &&
    input.user.model.modelID === model.modelID &&
    input.user.variant === assistant.variant

  if (userMatchesAssistant) return

  return {
    agent: assistant.agent,
    model,
    variant: assistant.variant,
  }
}
