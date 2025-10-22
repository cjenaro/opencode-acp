export function mapToolCall(toolName: string, toolInput: any) {
  return {
    name: toolName,
    description: `Tool: ${toolName}`,
  };
}

export function mapToolResult(toolName: string, result: any) {
  return {
    output: JSON.stringify(result),
  };
}
