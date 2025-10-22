import {
  AgentSideConnection,
  AuthenticateRequest,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
} from "@agentclientprotocol/sdk";
import {
  createOpencode,
  OpencodeClient,
  type Provider,
  type TextPart,
  type ToolPart,
  type ReasoningPart,
} from "@opencode-ai/sdk";
import { nodeToWebReadable, nodeToWebWritable } from "./utils.js";
import { promptToOpencode } from "./converters.js";

type Session = {
  id: string;
  opencodeSessionId: string;
  cancelled: boolean;
  currentModel?: string;
};

export class OpencodeAcpAgent {
  sessions: { [key: string]: Session };
  client: AgentSideConnection;
  opencodeClient: OpencodeClient | null = null;
  opencodeServer: { url: string; close: () => void } | null = null;

  constructor(client: AgentSideConnection) {
    this.sessions = {};
    this.client = client;
  }

  async initialize(_request: InitializeRequest): Promise<InitializeResponse> {
    try {
      const baseUrl = process.env.OPENCODE_BASE_URL || "http://localhost:4096";

      
      const opencode = await createOpencode({
        hostname: "127.0.0.1",
        port: 4096,
        timeout: 2000,
      });

      this.opencodeClient = opencode.client;
      this.opencodeServer = opencode.server;

      
    } catch (error: any) {
      if (
        error.code === "EADDRINUSE" ||
        error.message?.includes("EADDRINUSE")
      ) {
        
        const { createOpencodeClient } = await import("@opencode-ai/sdk");
        this.opencodeClient = createOpencodeClient({
          baseUrl: process.env.OPENCODE_BASE_URL || "http://localhost:4096",
        });
        
      } else {
        console.error("[opencode-acp] Failed to connect to opencode:", error);
        throw error;
      }
    }

    return {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
      },
      authMethods: [],
    };
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    if (!this.opencodeClient) {
      throw new Error("opencode client not initialized");
    }

    const sessionId = crypto.randomUUID();

    try {
      const { data: opencodeSession, error } =
        await this.opencodeClient.session.create({
          body: {
            title: `ACP Session ${new Date().toISOString()}`,
          },
        });

      if (error || !opencodeSession) {
        throw new Error(`Failed to create opencode session: ${error}`);
      }

      this.sessions[sessionId] = {
        id: sessionId,
        opencodeSessionId: opencodeSession.id,
        cancelled: false,
      };

      
      const { data: providersData, error: providersError } =
        await this.opencodeClient.config.providers();

      if (providersError || !providersData?.providers) {
        console.error(
          `[opencode-acp] Error getting providers:`,
          providersError
        );
        return {
          sessionId,
          models: {
            availableModels: [
              {
                modelId: "default",
                name: "Default Model",
                description: "opencode default model",
              },
            ],
            currentModelId: "default",
          },
        };
      }

      

      const availableModels = providersData.providers.flatMap(
        (provider: Provider) => {
          if (!provider.models || typeof provider.models !== "object") {
            console.error(
              `[opencode-acp] Provider ${provider.id} has no models object`
            );
            return [];
          }
          return Object.entries(provider.models).map(([modelId, model]) => ({
            modelId: `${provider.id}/${modelId}`,
            name: model.name || modelId,
            description: `${provider.name} - ${model.name || modelId}`,
          }));
        }
      );

      const defaultModel = availableModels[0]?.modelId || "default";
      this.sessions[sessionId].currentModel = defaultModel;
      

      return {
        sessionId,
        models: {
          availableModels:
            availableModels.length > 0
              ? availableModels
              : [
                  {
                    modelId: "default",
                    name: "Default Model",
                    description: "opencode default model",
                  },
                ],
          currentModelId: defaultModel,
        },
      };
    } catch (error) {
      console.error("[opencode-acp] Failed to create session:", error);
      throw error;
    }
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    throw new Error(
      "Authentication not required - configure opencode separately"
    );
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }

    if (!this.opencodeClient) {
      throw new Error("opencode client not initialized");
    }

    const session = this.sessions[params.sessionId];
    const parts = promptToOpencode(params);

    

    try {
      const model = session.currentModel || "default";
      const [providerID, modelID] = model.split("/");
      

      const { data: result, error } = await this.opencodeClient.session.prompt({
        path: { id: session.opencodeSessionId },
        body: {
          model: { providerID, modelID },
          parts,
        },
      });

      if (error) {
        console.error("[opencode-acp] Prompt error:", error);
        throw new Error(`Prompt failed: ${error}`);
      }

      if (!result) {
        throw new Error("No result from prompt");
      }

      

      for (const part of result.parts) {
        if (part.type === "text") {
          const textPart = part as TextPart;
          await this.client.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: textPart.text,
              },
            },
          });
        } else if (part.type === "tool") {
          const toolPart = part as ToolPart;
          if (toolPart.state.status === "completed") {
            await this.client.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_thought_chunk",
                content: {
                  type: "text",
                  text: toolPart.state.output,
                },
              },
            });
          }
        } else if (part.type === "reasoning") {
          const reasoningPart = part as ReasoningPart;
          await this.client.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: {
                type: "text",
                text: reasoningPart.text,
              },
            },
          });
        }
      }

      return { stopReason: "end_turn" };
    } catch (error) {
      console.error("[opencode-acp] Failed to send prompt:", error);
      throw error;
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }

    const session = this.sessions[params.sessionId];
    session.cancelled = true;

    if (this.opencodeClient) {
      try {
        await this.opencodeClient.session.abort({
          path: { id: session.opencodeSessionId },
        });
        
      } catch (error) {
        console.error("[opencode-acp] Failed to abort session:", error);
      }
    }
  }

  async setSessionModel(
    params: SetSessionModelRequest
  ): Promise<SetSessionModelResponse | void> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }

    const session = this.sessions[params.sessionId];
    
    session.currentModel = params.modelId;
  }
}

export function runAcp() {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);
  new AgentSideConnection((client) => new OpencodeAcpAgent(client), stream);
}