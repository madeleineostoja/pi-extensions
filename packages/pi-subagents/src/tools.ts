import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { getSubagentRuntime } from "./runtime.js";

export function registerAgentTools(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "Agent",
      label: "Agent",
      description: `Launches a subagent with its own context window. Use for parallel/isolated codebase exploration, concrete review, or complex research whose detail should stay out of main context. Do not use when a known file can be read directly, one search call is enough, or the work duplicates an existing background agent.

Types: General, Explore, Review.

Foreground default waits and returns result. Set background: true only for genuinely parallel or long-running work.

If you start background agents, join them with get_subagent_result({ wait: true }); do not poll or sleep.`,
      parameters: Type.Object({
        prompt: Type.String(),
        description: Type.String(),
        subagent_type: Type.Union([
          Type.Literal("General"),
          Type.Literal("Explore"),
          Type.Literal("Review"),
        ]),
        model: Type.Optional(Type.String()),
        thinking: Type.Optional(
          Type.Union([
            Type.Literal("off"),
            Type.Literal("minimal"),
            Type.Literal("low"),
            Type.Literal("medium"),
            Type.Literal("high"),
            Type.Literal("xhigh"),
          ]),
        ),
        background: Type.Optional(Type.Boolean()),
      }),
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
        const runtime = getSubagentRuntime();
        const id = await runtime.spawn(
          {
            type: params.subagent_type,
            prompt: params.prompt,
            description: params.description,
            model: params.model,
            thinking: params.thinking,
            background: params.background,
          },
          {
            modelRegistry: ctx.modelRegistry,
            parentModel: modelRefFromContext(ctx),
          },
        );

        if (params.background) {
          return {
            status: "success",
            content: [
              {
                type: "text",
                text: `Background agent started: ${id}`,
              },
            ],
            details: undefined,
          };
        }

        const result = await runtime.waitFor(id, signal);
        if (result.status === "completed") {
          return {
            status: "success",
            content: [{ type: "text", text: result.result }],
            details: undefined,
          };
        }
        return {
          status: "error",
          content: [
            {
              type: "text",
              text: result.error,
            },
          ],
          isError: true,
          details: undefined,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "get_subagent_result",
      label: "Get Subagent Result",
      description: `Checks the status of a background agent or joins it and returns the full result. Use wait: true to block until the agent reaches a terminal state and receive the complete result. Use wait: false to check the current status immediately without blocking.`,
      parameters: Type.Object({
        agent_id: Type.String(),
        wait: Type.Optional(Type.Boolean()),
        verbose: Type.Optional(Type.Boolean()),
      }),
      execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
        const runtime = getSubagentRuntime();
        if (params.wait) {
          const result = await runtime.waitFor(params.agent_id, signal);
          if (result.status === "completed") {
            return {
              status: "success",
              content: [
                {
                  type: "text",
                  text: result.result,
                },
              ],
              details: undefined,
            };
          }
          return {
            status: "error",
            content: [
              {
                type: "text",
                text: result.error,
              },
            ],
            isError: true,
            details: undefined,
          };
        }

        const record = runtime.getRecord(params.agent_id);
        if (!record) {
          return {
            status: "error",
            content: [
              {
                type: "text",
                text: `Agent ${params.agent_id} not found.`,
              },
            ],
            isError: true,
            details: undefined,
          };
        }

        const lines = [
          `Agent: ${record.id}`,
          `Type: ${record.type}`,
          `Status: ${record.status}`,
          `Description: ${record.description}`,
        ];
        if (record.model) {
          lines.push(`Model: ${record.model}`);
        }
        if (record.turns > 0) {
          lines.push(`Turns: ${record.turns}`);
        }
        if (record.toolUses > 0) {
          lines.push(`Tool uses: ${record.toolUses}`);
        }
        if (record.tokensTotal !== undefined) {
          lines.push(`Tokens: ${record.tokensTotal}`);
        }
        if (record.lastAssistantText && params.verbose) {
          lines.push(`Last output: ${record.lastAssistantText}`);
        }

        return {
          status: "success",
          content: [{ type: "text", text: lines.join("\n") }],
          details: undefined,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "steer_subagent",
      label: "Steer Subagent",
      description: `Sends a redirect or wrap-up message to a running background agent. Use sparingly when direction materially changes. Queued if the agent exists but its session is not yet initialized.`,
      parameters: Type.Object({
        agent_id: Type.String(),
        message: Type.String(),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
        const runtime = getSubagentRuntime();
        await runtime.steer(params.agent_id, params.message);
        return {
          status: "success",
          content: [
            {
              type: "text",
              text: `Steering message sent to ${params.agent_id}.`,
            },
          ],
          details: undefined,
        };
      },
    }),
  );
}

function modelRefFromContext(ctx: ExtensionContext): string | undefined {
  const model = ctx.model as { provider?: string; id?: string } | undefined;
  if (!model?.provider || !model.id) {
    return undefined;
  }
  return `${model.provider}/${model.id}`;
}
