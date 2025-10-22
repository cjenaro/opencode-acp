import {
  Agent,
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
import { createOpencode, OpencodeClient } from "@opencode-ai/sdk";
import { nodeToWebReadable, nodeToWebWritable } from "./utils.js";
import { promptToOpencode } from "./converters.js";

interface OpencodeProvider {
  id: string;
  name: string;
  models: Record<
    string,
    {
      id?: string;
      name?: string;
    }
  >;
}

interface OpencodeProvidersResponse {
  data?: {
    providers: OpencodeProvider[];
  };
  error?: string;
}

interface ExtendedPromptRequest extends PromptRequest {
  model?: string;
}

type Session = {
  id: string;
  opencodeSessionId: string;
  cancelled: boolean;
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

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    try {
      const baseUrl = process.env.OPENCODE_BASE_URL || "http://localhost:4096";

      console.error(
        `[opencode-acp] Attempting to connect to existing opencode at ${baseUrl}...`
      );
      const opencode = await createOpencode({
        hostname: "127.0.0.1",
        port: 4096,
        timeout: 2000,
      });

      this.opencodeClient = opencode.client;
      this.opencodeServer = opencode.server;

      console.error(
        `[opencode-acp] Connected to opencode at ${opencode.server.url}`
      );
    } catch (error: any) {
      if (
        error.code === "EADDRINUSE" ||
        error.message?.includes("EADDRINUSE")
      ) {
        console.error(
          "[opencode-acp] Port already in use, connecting to existing server..."
        );
        const { createOpencodeClient } = await import("@opencode-ai/sdk");
        this.opencodeClient = createOpencodeClient({
          baseUrl: process.env.OPENCODE_BASE_URL || "http://localhost:4096",
        });
        console.error("[opencode-acp] Connected to existing opencode server");
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

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
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

      console.error(
        `[opencode-acp] Created session ${sessionId} -> opencode ${opencodeSession.id}`
      );

      console.error(`[opencode-acp] Attempting to get providers list...`);
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

      console.error(
        `[opencode-acp] Available providers:`,
        providersData.providers.map((p: OpencodeProvider) => p.id).join(", ")
      );

      const availableModels = providersData.providers.flatMap(
        (provider: OpencodeProvider) => {
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
          currentModelId: availableModels[0]?.modelId || "default",
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

  async prompt(params: ExtendedPromptRequest): Promise<PromptResponse> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }

    if (!this.opencodeClient) {
      throw new Error("opencode client not initialized");
    }

    const session = this.sessions[params.sessionId];
    const parts = promptToOpencode(params);

    console.error(
      `[opencode-acp] Sending prompt to opencode session ${session.opencodeSessionId}`
    );
    console.error(`[opencode-acp] Parts:`, JSON.stringify(parts, null, 2));

    try {
      const [providerID, modelID] = params.model?.split("/") || [
        "anthropic",
        "claude-3-5-sonnet-20241022",
      ];

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

      console.error(`[opencode-acp] Got response from opencode`);

      for (const part of result.parts) {
        if (part.type === "text") {
          await this.client.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: part.text,
              },
            },
          });
        } else if (part.type === "thinking") {
          await this.client.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: {
                type: "text",
                text: part.text,
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
        console.error(
          `[opencode-acp] Aborted session ${session.opencodeSessionId}`
        );
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
  }
}

export function runAcp() {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);
  new AgentSideConnection((client) => new OpencodeAcpAgent(client), stream);
}
