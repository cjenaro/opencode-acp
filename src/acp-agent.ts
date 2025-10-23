import {
  AgentSideConnection,
  AuthenticateRequest,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
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
  cancelled: boolean;
  currentModel?: string;
  currentMode?: string;
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
        loadSession: false,
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

    if (!params.cwd) {
      throw new Error("cwd is required for session creation");
    }

    try {
      const { data: opencodeSession, error } =
        await this.opencodeClient.session.create({
          body: {
            title: `ACP Session ${new Date().toISOString()} (${params.cwd})`,
          },
        });

      if (error || !opencodeSession) {
        throw new Error(`Failed to create opencode session: ${error}`);
      }

      const sessionId = opencodeSession.id;

      this.sessions[sessionId] = {
        id: sessionId,
        cancelled: false,
        currentMode: "default",
      };

      const { data: providersData, error: providersError } =
        await this.opencodeClient.config.providers();

      if (providersError || !providersData?.providers) {
        console.error(
          `[opencode-acp] Error getting providers:`,
          providersError,
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
              `[opencode-acp] Provider ${provider.id} has no models object`,
            );
            return [];
          }
          return Object.entries(provider.models).map(([modelId, model]) => ({
            modelId: `${provider.id}/${modelId}`,
            name: model.name || modelId,
            description: `${provider.name} - ${model.name || modelId}`,
          }));
        },
      );

      const defaultModel = availableModels[0]?.modelId || "default";
      this.sessions[sessionId].currentModel = defaultModel;

      const sessionCommands = [
        {
          name: "init",
          description:
            "Create an AGENTS.md file with instructions for opencode",
          input: null,
        },
        {
          name: "compact",
          description:
            "Summarize conversation to prevent hitting context limit",
          input: null,
        },
        {
          name: "review",
          description: "Review current code changes and find issues",
          input: {
            hint: "optional custom review instructions",
          },
        },
      ];

      const availableModes = [
        {
          id: "default",
          name: "Always Ask",
          description: "Prompts for permission on first use of each tool",
        },
        {
          id: "acceptEdits",
          name: "Accept Edits",
          description:
            "Automatically accepts file edit permissions for the session",
        },
        {
          id: "plan",
          name: "Plan Mode",
          description:
            "opencode can analyze but not modify files or execute commands",
        },
      ];

      // Send available commands and modes after a short delay
      setTimeout(() => {
        this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: sessionCommands,
          },
        });

        this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: "default",
          },
        });
      }, 0);

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
        modes: {
          currentModeId: "default",
          availableModes,
        },
      };
    } catch (error) {
      console.error("[opencode-acp] Failed to create session:", error);
      throw error;
    }
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    throw new Error(
      "Authentication not required - configure opencode separately",
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

    // Handle slash commands
    const textContent =
      params.prompt.find((p) => p.type === "text")?.text || "";
    if (textContent.startsWith("/")) {
      return this.handleSlashCommand(params.sessionId, textContent);
    }

    const parts = promptToOpencode(params);

    try {
      const model = session.currentModel || "default";
      const [providerID, modelID] = model.split("/");

      // Subscribe to events for streaming
      let eventsStream;
      try {
        const events = await this.opencodeClient.event.subscribe();
        eventsStream = events.stream;
      } catch (eventError) {
        console.error(
          "[opencode-acp] Failed to subscribe to events:",
          eventError,
        );
        // Fallback to non-streaming
        return this.promptNonStreaming(
          params,
          session,
          parts,
          providerID,
          modelID,
        );
      }

      // Start the prompt
      const { data: result, error } = await this.opencodeClient!.session.prompt(
        {
          path: { id: params.sessionId },
          body: {
            model: { providerID, modelID },
            parts,
          },
        },
      );

      if (error) {
        console.error("[opencode-acp] Prompt error:", error);
        throw new Error(`Prompt failed: ${error}`);
      }

      if (!result) {
        throw new Error("No result from prompt");
      }

      // Process streaming events
      if (eventsStream) {
        try {
          for await (const event of eventsStream) {
            await this.handleStreamEvent(params.sessionId, event);
          }
        } catch (streamError) {
          console.error("[opencode-acp] Stream error:", streamError);
        }
      }

      // Send final result
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

  private async promptNonStreaming(
    params: PromptRequest,
    session: Session,
    parts: any[],
    providerID: string,
    modelID: string,
  ): Promise<PromptResponse> {
    const { data: result, error } = await this.opencodeClient!.session.prompt({
      path: { id: params.sessionId },
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

    for (const part of result!.parts) {
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
  }

  private async handleSlashCommand(
    sessionId: string,
    command: string,
  ): Promise<PromptResponse> {
    const [commandName, ...args] = command.slice(1).split(" ");
    const commandText = args.join(" ");

    if (!this.opencodeClient) {
      throw new Error("opencode client not initialized");
    }

    try {
      switch (commandName) {
        case "init":
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Creating AGENTS.md file with opencode instructions...",
              },
            },
          });

          const { data: initResult, error: initError } =
            await this.opencodeClient.session.init({
              path: { id: sessionId },
              body: {
                messageID: "init-" + Date.now(),
                providerID: "acp",
                modelID: "default",
              },
            });

          if (initError || !initResult) {
            await this.client.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: `Failed to create AGENTS.md: ${initError}`,
                },
              },
            });
          } else {
            await this.client.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: "AGENTS.md created successfully!",
                },
              },
            });
          }
          break;

        case "compact":
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Compacting conversation history...",
              },
            },
          });

          const { data: compactResult, error: compactError } =
            await this.opencodeClient.session.summarize({
              path: { id: sessionId },
              body: {
                providerID: "acp",
                modelID: "default",
              },
            });

          if (compactError || !compactResult) {
            await this.client.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: `Failed to compact conversation: ${compactError}`,
                },
              },
            });
          } else {
            await this.client.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: "Conversation compacted successfully!",
                },
              },
            });
          }
          break;

        case "review":
          const reviewPrompt =
            commandText || "Review current code changes and provide findings";
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Starting review: ${reviewPrompt}`,
              },
            },
          });

          const { data: commandResult, error: commandError } =
            await this.opencodeClient.session.command({
              path: { id: sessionId },
              body: {
                command: "review",
                arguments: reviewPrompt,
              },
            });

          if (commandError || !commandResult) {
            await this.client.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: `Review failed: ${commandError}`,
                },
              },
            });
          } else {
            // Stream the review results
            for (const part of commandResult.parts) {
              if (part.type === "text") {
                await this.client.sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                      type: "text",
                      text: part.text,
                    },
                  },
                });
              }
            }
          }
          break;

        default:
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Unknown command: /${commandName}. Available commands: /init, /compact, /review`,
              },
            },
          });
      }
    } catch (error) {
      console.error("[opencode-acp] Error handling slash command:", error);
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Error executing command: /${commandName} - ${error}`,
          },
        },
      });
    }

    return { stopReason: "end_turn" };
  }

  private async handleStreamEvent(
    sessionId: string,
    event: any,
  ): Promise<void> {
    try {
      switch (event.type) {
        case "tool_start":
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: event.properties.toolCallId || event.properties.id,
              status: "pending",
              title: event.properties.name || "Running tool",
              rawInput: event.properties.input,
            },
          });
          break;

        case "tool_update":
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: event.properties.toolCallId || event.properties.id,
              status: "in_progress",
              rawOutput: event.properties.output,
            },
          });
          break;

        case "tool_complete":
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: event.properties.toolCallId || event.properties.id,
              status: "completed",
              rawOutput: event.properties.output,
            },
          });
          break;

        case "text_delta":
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: event.properties.text,
              },
            },
          });
          break;

        case "reasoning_delta":
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: {
                type: "text",
                text: event.properties.text,
              },
            },
          });
          break;

        case "plan_update":
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "plan",
              entries: (event.properties?.plan || []).map((item: any) => ({
                content: item?.step || item?.description || "",
                priority: "medium",
                status:
                  item?.status === "completed"
                    ? "completed"
                    : item?.status === "in_progress"
                      ? "in_progress"
                      : "pending",
              })),
            },
          });
          break;

        default:
          console.log(
            "[opencode-acp] Unhandled event type:",
            event.type,
            event.properties,
          );
      }
    } catch (error) {
      console.error("[opencode-acp] Error handling stream event:", error);
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
          path: { id: params.sessionId },
        });
      } catch (error) {
        console.error("[opencode-acp] Failed to abort session:", error);
      }
    }
  }

  async setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }

    const session = this.sessions[params.sessionId];
    session.currentModel = params.modelId;
  }

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse | void> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }

    // Validate modeId against available modes
    const availableModes = [
      "default",
      "acceptEdits", 
      "plan"
    ];
    
    if (!availableModes.includes(params.modeId)) {
      throw new Error(`Invalid mode: ${params.modeId}. Available modes: ${availableModes.join(", ")}`);
    }

    // Store the current mode in session
    this.sessions[params.sessionId].currentMode = params.modeId;

    // Send the update notification
    await this.client.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: params.modeId,
      },
    });

    return { meta: {} };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!this.opencodeClient) {
      throw new Error("opencode client not initialized");
    }

    if (!params.cwd) {
      throw new Error("cwd is required for session loading");
    }

    try {
      const { data: opencodeSession, error } =
        await this.opencodeClient.session.get({
          path: { id: params.sessionId },
        });

      if (error || !opencodeSession) {
        throw new Error(`Failed to load opencode session: ${error}`);
      }

      this.sessions[params.sessionId] = {
        id: params.sessionId,
        cancelled: false,
        currentMode: "default",
      };

      const { data: providersData, error: providersError } =
        await this.opencodeClient.config.providers();

      if (providersError || !providersData?.providers) {
        console.error(
          `[opencode-acp] Error getting providers:`,
          providersError,
        );
        return {};
      }

      const availableModels = providersData.providers.flatMap(
        (provider: Provider) => {
          if (!provider.models || typeof provider.models !== "object") {
            return [];
          }
          return Object.entries(provider.models).map(([modelId, model]) => ({
            modelId: `${provider.id}/${modelId}`,
            name: model.name || modelId,
            description: `${provider.name} - ${model.name || modelId}`,
          }));
        },
      );

      const defaultModel = availableModels[0]?.modelId || "default";
      this.sessions[params.sessionId].currentModel = defaultModel;

      const { data: messagesData } = await this.opencodeClient.session.messages(
        {
          path: { id: params.sessionId },
        },
      );

      if (messagesData) {
        for (const message of messagesData) {
          for (const part of message.parts) {
            if (part.type === "text") {
              const updateType =
                message.info.role === "user"
                  ? "user_message_chunk"
                  : "agent_message_chunk";

              await this.client.sessionUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: updateType,
                  content: {
                    type: "text",
                    text: part.text,
                  },
                },
              });
            } else if (
              part.type === "reasoning" &&
              message.info.role === "assistant"
            ) {
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
        }
      }

      const availableModes = [
        {
          id: "default",
          name: "Always Ask",
          description: "Prompts for permission on first use of each tool",
        },
        {
          id: "acceptEdits",
          name: "Accept Edits",
          description:
            "Automatically accepts file edit permissions for the session",
        },
        {
          id: "plan",
          name: "Plan Mode",
          description:
            "opencode can analyze but not modify files or execute commands",
        },
      ];

      return {
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
        modes: {
          currentModeId: this.sessions[params.sessionId].currentMode || "default",
          availableModes,
        },
      };
    } catch (error) {
      console.error("[opencode-acp] Failed to load session:", error);
      throw error;
    }
  }

  async _session_list(): Promise<{ sessions: any[] }> {
    if (!this.opencodeClient) {
      throw new Error("opencode client not initialized");
    }

    try {
      const { data: sessions, error } =
        await this.opencodeClient.session.list();

      if (error) {
        throw new Error(`Failed to list sessions: ${error}`);
      }

      // Transform sessions to include metadata Zed might need
      const transformedSessions = (sessions || []).map((session) => ({
        id: session.id,
        title: session.title || `Session ${session.id}`,
        createdAt: session.time.created,
        updatedAt: session.time.updated,
        cwd: session.directory,
      }));

      return {
        sessions: transformedSessions,
      };
    } catch (error) {
      console.error("[opencode-acp] Failed to list sessions:", error);
      throw error;
    }
  }
}

export function runAcp() {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);
  new AgentSideConnection((client) => new OpencodeAcpAgent(client), stream);
}
