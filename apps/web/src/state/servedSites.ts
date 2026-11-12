import { createServedSitesEnvironmentAtoms } from "@t3tools/client-runtime/state/servedSites";
import {
  type EnvironmentId,
  isServedSiteTearingDown,
  type ServedSite,
  type ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

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

const NO_LINES: ReadonlyArray<string> = [];
const NO_LINES_ATOM = Atom.make(NO_LINES).pipe(Atom.withLabel("served-sites-live-lines:none"));

const sameLines = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((line, index) => line === b[index]);

// Keyed by `environmentId\0threadId`; reuses the previous array so sidebar rows skip re-rendering.
const liveSiteLinesAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = key.split("\u0000") as [EnvironmentId, ThreadId];
  return Atom.make((get) => {
    const result = get(servedSitesEnvironment.list({ environmentId, input: {} }));
    const sites = AsyncResult.getOrElse(result, () => null)?.sites ?? [];
    const next = sites.flatMap((site) => {
      const url =
        site.threadId === threadId && site.status === "live" && !isServedSiteTearingDown(site)
          ? siteUrl(site)
          : null;
      return url === null ? [] : [`${site.name}: ${url}`];
    });
    if (next.length === 0) return NO_LINES;
    const previous = Option.getOrNull(get.self<ReadonlyArray<string>>());
    return previous !== null && sameLines(previous, next) ? previous : next;
  }).pipe(Atom.withLabel("served-sites-live-lines"));
});

/** `name: url` for each of the thread's live sites. */
export function useThreadLiveSiteLines(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): ReadonlyArray<string> {
  const supported =
    useEnvironment(input.environmentId)?.serverConfig?.environment.capabilities.servedSites !==
    undefined;
  return useAtomValue(
    supported ? liveSiteLinesAtom(`${input.environmentId}\u0000${input.threadId}`) : NO_LINES_ATOM,
  );
}
