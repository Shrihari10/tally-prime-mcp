import type { z } from "zod";
import type { TallyClient } from "../tally/client.js";

export type ToolHandler = (
  args: any,
  client: TallyClient
) => Promise<string>;

export interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: ToolHandler;
}
