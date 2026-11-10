import { OrchestratorMcpFailure, type ServedSiteError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as ServedSites from "../../../servedSites/ServedSites.ts";
import { assertNotLinked } from "../../linkOrigin.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { ServedSitesToolkit } from "./tools.ts";

const siteFailure = (error: ServedSiteError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "invalid" || error.reason === "not-found"
        ? "invalid_request"
        : "orchestration_error",
    message: error.detail,
  });

export const layer = McpToolAccess.toLayer(
  ServedSitesToolkit,
  Effect.gen(function* () {
    const sites = yield* ServedSites.ServedSites;
    const projects = yield* ProjectService.ProjectService;

    const projectCwd = Effect.fn("ServedSitesHandlers.projectCwd")(function* (shell: {
      readonly projectId: Parameters<typeof projects.getById>[0];
      readonly worktreePath: string | null;
    }) {
      if (shell.worktreePath !== null) return shell.worktreePath;
      const project = yield* projects.getById(shell.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(project)) return yield* unavailable();
      return project.value.workspaceRoot;
    });

    return {
      t3_site_publish: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const caller = yield* loadCaller();
          yield* McpInvocationContext.requireThreadScope(caller.scope, "This tool");
          yield* assertNotLinked(caller, "publish this machine's servers");
          if (caller.caller === undefined) return yield* unavailable();
          return yield* sites
            .publish({
              threadId: caller.caller.id,
              projectCwd: yield* projectCwd(caller.caller),
              port: input.port,
              pids: input.pids,
              name: input.name,
              visibility: input.visibility ?? "tailnet",
              stopCommand: input.stopCommand,
            })
            .pipe(Effect.mapError(siteFailure));
        }),
      ),
      t3_site_list: McpToolAccess.reads(() =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const all = yield* sites.list;
          const threadId = scope.thread?.threadId;
          return {
            sites: threadId === undefined ? all : all.filter((site) => site.threadId === threadId),
          };
        }),
      ),
      t3_site_stop: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const caller = yield* loadCaller();
          yield* assertNotLinked(caller, "stop this machine's servers");
          return yield* sites.stop(input).pipe(Effect.mapError(siteFailure));
        }),
      ),
    } satisfies McpToolAccess.Handlers<typeof ServedSitesToolkit.tools>;
  }),
);
