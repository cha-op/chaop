import { handleRequest } from "./routes.js";
import type { Env } from "./types.js";
export { WorkspaceDO } from "./workspace-do.js";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  }
};
