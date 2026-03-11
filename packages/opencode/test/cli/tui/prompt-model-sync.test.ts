import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import {
  getPromptStateFromCompletedAssistant,
  isInternalRuntimeFallbackPrompt,
} from "../../../src/cli/cmd/tui/component/prompt/session-model-sync"

function userMessage(input?: Partial<Pick<UserMessage, "agent" | "model" | "variant">>): UserMessage {
  return {
    id: "msg_user",
    sessionID: "ses_test",
    role: "user",
    time: { created: 1 },
    agent: input?.agent ?? "Sisyphus (Ultraworker)",
    model: input?.model ?? { providerID: "anthropic", modelID: "claude-opus-4-6" },
    variant: input?.variant,
  }
}

function assistantMessage(
  input?: Partial<Pick<AssistantMessage, "agent" | "providerID" | "modelID" | "variant" | "time" | "error">>,
): AssistantMessage {
  return {
    id: "msg_assistant",
    sessionID: "ses_test",
    role: "assistant",
    time: input?.time ?? { created: 2, completed: 3 },
    parentID: "msg_user",
    providerID: input?.providerID ?? "openai",
    modelID: input?.modelID ?? "gpt-5.4",
    mode: input?.agent ?? "Sisyphus (Ultraworker)",
    agent: input?.agent ?? "Sisyphus (Ultraworker)",
    path: {
      cwd: "/project",
      root: "/project",
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    variant: input?.variant,
    error: input?.error,
  }
}

describe("prompt model sync", () => {
  test("detects internal runtime fallback prompt markers", () => {
    const parts: Part[] = [
      {
        id: "part",
        messageID: "msg_user",
        sessionID: "ses_test",
        type: "text",
        text: "continue\n<!-- OMO_INTERNAL_INITIATOR -->",
      },
    ]

    expect(isInternalRuntimeFallbackPrompt(parts)).toBe(true)
  })

  test("returns the completed assistant fallback model for the next turn", () => {
    const result = getPromptStateFromCompletedAssistant({
      assistant: assistantMessage(),
      user: userMessage(),
      primaryAgents: ["Sisyphus (Ultraworker)"],
    })

    expect(result).toEqual({
      agent: "Sisyphus (Ultraworker)",
      model: { providerID: "openai", modelID: "gpt-5.4" },
      variant: undefined,
    })
  })

  test("skips syncing when the assistant already matches the last user turn", () => {
    const result = getPromptStateFromCompletedAssistant({
      assistant: assistantMessage({
        providerID: "anthropic",
        modelID: "claude-opus-4-6",
        variant: "max",
      }),
      user: userMessage({
        model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
        variant: "max",
      }),
      primaryAgents: ["Sisyphus (Ultraworker)"],
    })

    expect(result).toBeUndefined()
  })

  test("skips syncing for incomplete or non-primary assistant turns", () => {
    const incomplete = getPromptStateFromCompletedAssistant({
      assistant: assistantMessage({ time: { created: 2 } }),
      user: userMessage(),
      primaryAgents: ["Sisyphus (Ultraworker)"],
    })

    const subagent = getPromptStateFromCompletedAssistant({
      assistant: assistantMessage({ agent: "oracle" }),
      user: userMessage({ agent: "oracle" }),
      primaryAgents: ["Sisyphus (Ultraworker)"],
    })

    expect(incomplete).toBeUndefined()
    expect(subagent).toBeUndefined()
  })
})
