import type { JSONValue, ModelMessage } from "ai";
import type { LlmProvider } from "./interface.js";

/**
 * Build a `prepareStep` that marks the prompt prefix for caching by putting
 * a provider-specific marker on the last message of every step.
 *
 * The step's messages are rebuilt from the call's initial messages plus the
 * responses accumulated so far, rather than taken from `messages`: a
 * `messages` override returned from `prepareStep` carries forward into the
 * next step, so marking `messages` would keep every earlier step's marker
 * too. Providers cap the number of cache breakpoints per request (four for
 * Anthropic and Bedrock), and a long tool loop would exceed it.
 */
export function markLastMessageForCaching(
  providerKey: string,
  marker: Record<string, JSONValue>,
): NonNullable<LlmProvider["prepareStep"]> {
  return ({ initialMessages, responseMessages }) => {
    const messages: ModelMessage[] = [...initialMessages, ...responseMessages];
    const last = messages.length - 1;
    return {
      messages: messages.map((msg, i) =>
        i === last
          ? {
              ...msg,
              providerOptions: {
                ...(msg.providerOptions ?? {}),
                [providerKey]: marker,
              },
            }
          : msg,
      ),
    };
  };
}
