import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { SessionID, MessageID, PartID } from "./schema"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { ProviderTransform } from "@/provider/transform"
import type { ModelMessage } from "ai"
import { ModelID, ProviderID } from "@/provider/schema"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: SessionID.zod,
      }),
    ),
  }

  const COMPACTION_BUFFER = 20_000
  const COMPACTION_PART_CHAR_LIMIT = 4_000
  const AGGRESSIVE_COMPACTION_PART_CHAR_LIMIT = 1_200

  function truncateTextForCompaction(text: string, limit: number) {
    if (text.length <= limit) return text
    const head = Math.max(200, Math.floor(limit * 0.75))
    const tail = Math.max(100, limit - head)
    const omitted = Math.max(0, text.length - head - tail)
    return [
      text.slice(0, head),
      `[Truncated for compaction: ${omitted} chars omitted]`,
      text.slice(-tail),
    ].join("\n\n")
  }

  function compressMessageForCompaction(input: MessageV2.WithParts, limit = COMPACTION_PART_CHAR_LIMIT): MessageV2.WithParts {
    return {
      info: input.info,
      parts: input.parts.map((part) => {
        if (part.type === "text") {
          return { ...part, text: truncateTextForCompaction(part.text, limit) }
        }
        if (part.type === "reasoning") {
          return {
            ...part,
            text: truncateTextForCompaction(part.text, Math.max(400, Math.floor(limit / 2))),
          }
        }
        if (part.type === "tool") {
          if (part.state.status === "completed") {
            return {
              ...part,
              state: {
                ...part.state,
                output: truncateTextForCompaction(part.state.output, limit),
                attachments: [],
              },
            }
          }
          if (part.state.status === "error") {
            return {
              ...part,
              state: {
                ...part.state,
                error: truncateTextForCompaction(part.state.error, Math.max(400, Math.floor(limit / 2))),
              },
            }
          }
          if (part.state.status === "pending") {
            return {
              ...part,
              state: {
                ...part.state,
                raw: truncateTextForCompaction(part.state.raw, Math.max(400, Math.floor(limit / 2))),
              },
            }
          }
        }
        return part
      }),
    }
  }

  function estimateCompactionValue(value: unknown): number {
    if (typeof value === "string") return Token.estimate(value)
    if (typeof value === "number" || typeof value === "boolean") return 1
    if (!value) return 0
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateCompactionValue(item), 0)
    if (typeof value === "object") {
      return Object.entries(value).reduce(
        (sum, [key, item]) => sum + Token.estimate(key) + estimateCompactionValue(item),
        0,
      )
    }
    return 0
  }

  function estimateCompactionMessages(messages: ModelMessage[]) {
    return messages.reduce((sum, message) => sum + estimateCompactionValue(message.content), 0)
  }

  async function inputBudget(model: Provider.Model) {
    const config = await Config.get()
    const context = model.limit.context
    if (context === 0) return Number.POSITIVE_INFINITY
    const reserved =
      config.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(model))
    const usable = model.limit.input
      ? model.limit.input - reserved
      : context - ProviderTransform.maxOutputTokens(model)
    return Math.max(0, usable)
  }

  function summaryPrefixCount(messages: MessageV2.WithParts[]) {
    if (messages.length < 2) return 0
    const [first, second] = messages
    if (!first || !second) return 0
    if (first.info.role !== "user" || second.info.role !== "assistant") return 0
    if (!first.parts.some((part) => part.type === "compaction")) return 0
    if (!second.info.summary || second.info.error) return 0
    return 2
  }

  async function toCompactionModelMessages(input: {
    messages: MessageV2.WithParts[]
    model: Provider.Model
    promptText: string
  }) {
    return [
      ...(await MessageV2.toModelMessages(input.messages, input.model, { stripMedia: true })),
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: input.promptText,
          },
        ],
      },
    ] satisfies ModelMessage[]
  }

  async function estimateSourceMessage(input: { message: MessageV2.WithParts; model: Provider.Model }) {
    const converted = await MessageV2.toModelMessages([input.message], input.model, { stripMedia: true })
    return estimateCompactionMessages(converted)
  }

  async function selectCompactionWindow(input: {
    messages: MessageV2.WithParts[]
    model: Provider.Model
    budget: number
    promptEstimate: number
  }) {
    const prefixCount = summaryPrefixCount(input.messages)
    const promptBudget = Number.isFinite(input.budget) ? Math.max(0, input.budget - input.promptEstimate) : input.budget
    const selected: MessageV2.WithParts[] = []
    let used = 0
    let sawUser = false

    for (let index = input.messages.length - 1; index >= prefixCount; index--) {
      let candidate = input.messages[index]!
      let estimate = await estimateSourceMessage({ message: candidate, model: input.model })
      const mustKeep = selected.length === 0 || !sawUser
      const remaining = Number.isFinite(promptBudget) ? promptBudget - used : Number.POSITIVE_INFINITY

      if (estimate > remaining && mustKeep) {
        candidate = compressMessageForCompaction(candidate, AGGRESSIVE_COMPACTION_PART_CHAR_LIMIT)
        estimate = await estimateSourceMessage({ message: candidate, model: input.model })
      }

      if (!mustKeep && estimate > remaining) continue

      selected.unshift(candidate)
      used += estimate
      if (candidate.info.role === "user") sawUser = true
    }

    if (selected.length === 0) {
      const fallback = input.messages.at(-1)
      if (!fallback) return []
      return [compressMessageForCompaction(fallback, AGGRESSIVE_COMPACTION_PART_CHAR_LIMIT)]
    }

    while (selected[0]?.info.role === "assistant") {
      const assistant = selected[0].info
      const hasParent = selected.some((message) => message.info.role === "user" && message.info.id === assistant.parentID)
      if (hasParent) break
      selected.shift()
    }

    if (prefixCount === 0) return selected

    const prefix = input.messages.slice(0, prefixCount)
    let prefixEstimate = 0
    for (const message of prefix) {
      prefixEstimate += await estimateSourceMessage({ message, model: input.model })
    }

    if (prefixEstimate + used <= promptBudget) return [...prefix, ...selected]
    return selected
  }

  export async function prepareMessages(input: {
    messages: MessageV2.WithParts[]
    model: Provider.Model
    promptText: string
  }) {
    const budget = await inputBudget(input.model)
    const exactMessages = await toCompactionModelMessages(input)
    const exactEstimate = estimateCompactionMessages(exactMessages)
    if (exactEstimate <= budget) {
      return {
        messages: exactMessages,
        budget,
        estimate: exactEstimate,
        truncated: false,
        trimmed: false,
      }
    }

    const truncatedSource = input.messages.map((message) => compressMessageForCompaction(message))
    const truncatedPrompt = [
      "Some long message content and tool output was truncated to fit the compaction model's context window.",
      input.promptText,
    ].join("\n\n")
    const truncatedMessages = await toCompactionModelMessages({
      messages: truncatedSource,
      model: input.model,
      promptText: truncatedPrompt,
    })
    const truncatedEstimate = estimateCompactionMessages(truncatedMessages)
    if (truncatedEstimate <= budget) {
      return {
        messages: truncatedMessages,
        budget,
        estimate: truncatedEstimate,
        truncated: true,
        trimmed: false,
      }
    }

    const promptEstimate = Token.estimate(truncatedPrompt)
    const trimmedSource = await selectCompactionWindow({
      messages: truncatedSource,
      model: input.model,
      budget,
      promptEstimate,
    })
    const trimmedPrompt = [
      "Only the most relevant recent turns, plus any prior compaction summary that still fits, are included below because the full session exceeded the compaction model's context window.",
      truncatedPrompt,
    ].join("\n\n")
    const trimmedMessages = await toCompactionModelMessages({
      messages: trimmedSource,
      model: input.model,
      promptText: trimmedPrompt,
    })
    return {
      messages: trimmedMessages,
      budget,
      estimate: estimateCompactionMessages(trimmedMessages),
      truncated: true,
      trimmed: trimmedSource.length < input.messages.length,
    }
  }

  export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    const config = await Config.get()
    if (config.compaction?.auto === false) return false
    const context = input.model.limit.context
    if (context === 0) return false

    const count =
      input.tokens.total ||
      input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write

    const reserved =
      config.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
    const usable = input.model.limit.input
      ? input.model.limit.input - reserved
      : context - ProviderTransform.maxOutputTokens(input.model)
    return count >= usable
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  const PRUNE_PROTECTED_TOOLS = ["skill"]

  // goes backwards through parts until there are 40_000 tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.
  export async function prune(input: { sessionID: SessionID }) {
    const config = await Config.get()
    if (config.compaction?.prune === false) return
    log.info("pruning")
    const msgs = await Session.messages({ sessionID: input.sessionID })
    let total = 0
    let pruned = 0
    const toPrune = []
    let turns = 0

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "user") turns++
      if (turns < 2) continue
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue

            if (part.state.time.compacted) break loop
            const estimate = Token.estimate(part.state.output)
            total += estimate
            if (total > PRUNE_PROTECT) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    log.info("found", { pruned, total })
    if (pruned > PRUNE_MINIMUM) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          await Session.updatePart(part)
        }
      }
      log.info("pruned", { count: toPrune.length })
    }
  }

  export async function process(input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    abort: AbortSignal
    auto: boolean
    overflow?: boolean
  }) {
    const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)!.info as MessageV2.User

    let messages = input.messages
    let replay: MessageV2.WithParts | undefined
    if (input.overflow) {
      const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
      for (let i = idx - 1; i >= 0; i--) {
        const msg = input.messages[i]
        if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
          replay = msg
          messages = input.messages.slice(0, i)
          break
        }
      }
      const hasContent =
        replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
      if (!hasContent) {
        replay = undefined
        messages = input.messages
      }
    }

    const agent = await Agent.get("compaction")
    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
    const msg = (await Session.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      variant: userMessage.variant,
      summary: true,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.id,
      providerID: model.providerID,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant
    const processor = SessionProcessor.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      abort: input.abort,
    })
    // Allow plugins to inject context or replace compaction prompt
    const compacting = await Plugin.trigger(
      "experimental.session.compacting",
      { sessionID: input.sessionID },
      { context: [], prompt: undefined },
    )
    const defaultPrompt = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary that you construct will be used so that another agent can read it and continue the work.

When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---`

    const promptText = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")
    const msgs = structuredClone(messages)
    await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
    const prepared = await prepareMessages({
      messages: msgs,
      model,
      promptText,
    })
    if (prepared.truncated || prepared.trimmed) {
      log.info("reduced compaction input", {
        sessionID: input.sessionID,
        estimate: prepared.estimate,
        budget: prepared.budget,
        truncated: prepared.truncated,
        trimmed: prepared.trimmed,
      })
    }
    const result = await processor.process({
      user: userMessage,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [],
      messages: prepared.messages,
      model,
    })

    if (result === "compact") {
      processor.message.error = new MessageV2.ContextOverflowError({
        message: replay
          ? "Conversation history too large to compact - exceeds model context limit even after reducing compaction input"
          : "Session too large to compact - context exceeds model limit even after reducing compaction input",
      }).toObject()
      processor.message.finish = "error"
      await Session.updateMessage(processor.message)
      return "stop"
    }

    if (result === "continue" && input.auto) {
      if (replay) {
        const original = replay.info as MessageV2.User
        const replayMsg = await Session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: original.agent,
          model: original.model,
          format: original.format,
          tools: original.tools,
          system: original.system,
          variant: original.variant,
        })
        for (const part of replay.parts) {
          if (part.type === "compaction") continue
          const replayPart =
            part.type === "file" && MessageV2.isMedia(part.mime)
              ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
              : part
          await Session.updatePart({
            ...replayPart,
            id: PartID.ascending(),
            messageID: replayMsg.id,
            sessionID: input.sessionID,
          })
        }
      } else {
        const continueMsg = await Session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: userMessage.agent,
          model: userMessage.model,
        })
        const text =
          (input.overflow
            ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
            : "") +
          "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: continueMsg.id,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          text,
          time: {
            start: Date.now(),
            end: Date.now(),
          },
        })
      }
    }
    if (processor.message.error) return "stop"
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    return "continue"
  }

  export const create = fn(
    z.object({
      sessionID: SessionID.zod,
      agent: z.string(),
      model: z.object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      }),
      auto: z.boolean(),
      overflow: z.boolean().optional(),
    }),
    async (input) => {
      const msg = await Session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    },
  )
}
