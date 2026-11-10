import { createServedSitesEnvironmentAtoms } from "@t3tools/client-runtime/state/servedSites";
import type { EnvironmentId, ServedSite, ThreadId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironment } from "./environments";
import { useEnvironmentQuery } from "./query";

export const servedSitesEnvironment = createServedSitesEnvironmentAtoms(connectionAtomRuntime);

export const siteUrl = (site: ServedSite) =>
  site.visibility === "public" ? (site.publicUrl ?? site.tailnetUrl) : site.tailnetUrl;

const NO_SITES: ReadonlyArray<ServedSite> = [];

/** The thread's served sites; empty when its server cannot serve sites. */
export function useThreadServedSites(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): ReadonlyArray<ServedSite> {
  const supported =
    useEnvironment(input.environmentId)?.serverConfig?.environment.capabilities.servedSites !==
    undefined;
  const { data } = useEnvironmentQuery(
    supported
      ? servedSitesEnvironment.list({ environmentId: input.environmentId, input: {} })
      : null,
  );
  if (data === null) return NO_SITES;
  const sites = data.sites.filter((site) => site.threadId === input.threadId);
  return sites.length === 0 ? NO_SITES : sites;
}

export function useThreadLiveSiteUrls(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): ReadonlyArray<string> {
  return useThreadServedSites(input).flatMap((site) => {
    const url = site.status === "live" ? siteUrl(site) : null;
    return url === null ? [] : [url];
  });
}
