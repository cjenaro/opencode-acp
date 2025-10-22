import type { PromptRequest } from "@agentclientprotocol/sdk";
import { type TextPartInput, type FilePartInput } from "@opencode-ai/sdk";

type OpencodePromptPart = TextPartInput | FilePartInput;

export function promptToOpencode(prompt: PromptRequest): OpencodePromptPart[] {
  const parts: OpencodePromptPart[] = [];

  for (const chunk of prompt.prompt) {
    switch (chunk.type) {
      case "text":
        parts.push({ type: "text", text: chunk.text });
        break;
      case "resource_link":
        parts.push({ type: "text", text: `[@${chunk.uri}](${chunk.uri})` });
        break;
      case "resource":
        if ("text" in chunk.resource) {
          parts.push({
            type: "text",
            text: `[@${chunk.resource.uri}](${chunk.resource.uri})\n\n${chunk.resource.text}`,
          });
        }
        break;
      case "image":
        if (chunk.data) {
          parts.push({
            type: "file",
            mime: chunk.mimeType,
            url: chunk.data,
          });
        }
        break;
      default:
        break;
    }
  }

  return parts;
}