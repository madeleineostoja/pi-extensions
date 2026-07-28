import { relative, resolve } from "node:path";
import type { Static, TSchema } from "typebox";
import type {
  SpawnArgs,
  SubagentClient,
  SubagentHandle,
  SubagentResult,
} from "./subagents.js";

export class ScriptedSubagentClient implements SubagentClient {
  readonly invocations: SpawnArgs[] = [];
  #responses: Array<SubagentResult<unknown>>;

  constructor(
    responses: Array<SubagentResult<unknown>>,
    readonly readableRoots: string[],
  ) {
    this.#responses = [...responses];
  }

  async spawn<TSchemaValue extends TSchema = TSchema>(
    args: SpawnArgs<TSchemaValue>,
  ): Promise<SubagentHandle<Static<TSchemaValue>>> {
    this.invocations.push(args);
    return `scripted-${this.invocations.length}` as SubagentHandle<
      Static<TSchemaValue>
    >;
  }

  async stop(): Promise<void> {}

  async waitFor<TResult>(
    id: SubagentHandle<TResult>,
  ): Promise<SubagentResult<TResult>> {
    const response = this.#responses.shift();
    if (!response) {
      return { status: "failed", error: `No scripted response for ${id}` };
    }
    return response as SubagentResult<TResult>;
  }

  assertReadable(path: string): void {
    const canonical = resolve(path);
    if (
      !this.readableRoots.some((root) => {
        const relativePath = relative(resolve(root), canonical);
        return (
          relativePath === "" ||
          (!relativePath.startsWith("..") && !relativePath.includes("../"))
        );
      })
    ) {
      throw new Error(
        `Scripted worker cannot read outside its assigned roots: ${path}`,
      );
    }
  }
}
