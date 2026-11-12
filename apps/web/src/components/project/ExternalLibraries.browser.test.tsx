import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type CodeServerStatus,
  EnvironmentId,
  type ProjectEntry,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";

type Listing = { readonly cwd: string; readonly directoryPath: string };

const mocks = vi.hoisted(() => ({
  status: { data: null, failure: null } as { data: unknown; failure: unknown },
  listings: [] as Array<{ cwd: string; directoryPath: string }>,
  entries: new Map<string, ReadonlyArray<ProjectEntry>>(),
  failing: new Set<string>(),
}));

vi.mock(import("~/state/codeIntel"), () => ({
  codeIntelEnvironment: {
    status: (request: unknown) => ({ rpc: "status", request }),
  } as never,
}));
vi.mock(import("~/state/projects"), async (original) => ({
  ...(await original()),
  projectEnvironment: {
    listEntries: (request: unknown) => ({ rpc: "listEntries", request }),
  } as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    error: null,
    isPending: false,
    dataUpdatedAt: 0,
    ...mocks.status,
  })) as never,
}));
vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  executeAtomQuery: (async (_registry: unknown, atom: { request: { input: Listing } }) => {
    const { cwd, directoryPath } = atom.request.input;
    mocks.listings.push({ cwd, directoryPath });
    const key = `${cwd}\n${directoryPath}`;
    if (mocks.failing.has(key)) return { _tag: "Failure" };
    return { _tag: "Success", value: { entries: mocks.entries.get(key) ?? [] } };
  }) as never,
}));

import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import ExternalLibraries from "./ExternalLibraries";

const environmentId = EnvironmentId.make("env-libs");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-libs"));

const SITE_PACKAGES = "/work/.venv/lib/python3.13/site-packages";
const TYPESHED = "/cache/ty/typeshed/stdlib";

function python(libraryRoots: CodeServerStatus["libraryRoots"]): CodeServerStatus {
  return { languageId: "python", name: "ty", state: "ready", libraryRoots };
}

function setup(servers: ReadonlyArray<CodeServerStatus> | null, failure: unknown = null) {
  mocks.status = { data: servers === null ? null : { servers }, failure };
  mocks.listings.length = 0;
  mocks.failing.clear();
  mocks.entries.clear();
  mocks.entries.set(`${SITE_PACKAGES}\n`, [
    { path: "stripe", kind: "directory" },
    { path: "six.py", kind: "file" },
  ]);
  mocks.entries.set(`${SITE_PACKAGES}\nstripe`, [
    { path: "stripe/_invoice.py", kind: "file" },
    // A listing may carry entries from deeper down; only the folder's own children show.
    { path: "stripe/api/deep.py", kind: "file" },
  ]);
  useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
}

const treeRow = (path: string) => {
  for (const host of document.querySelectorAll("*")) {
    const row = host.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
    if (row) return row;
  }
  return null;
};
const header = () => page.getByRole("button", { name: "External Libraries" });
const retry = () => page.getByRole("button", { name: /Click to retry/ });

function mount() {
  return render(
    <ExternalLibraries environmentId={environmentId} cwd="/work" threadRef={threadRef} />,
  );
}

async function expandSection() {
  await header().click();
  await vi.waitFor(() => expect(treeRow("site-packages/")).not.toBeNull());
}

describe("ExternalLibraries", () => {
  it.each([
    ["status is loading", null, null],
    ["status fails", null, new Error("down")],
    ["no server lists a root", [python([])], null],
    [
      "the only roots are stubs",
      [python([{ path: TYPESHED, label: "typeshed", kind: "stubs" }])],
      null,
    ],
  ])("renders nothing while %s", async (_name, servers, failure) => {
    setup(servers, failure);
    await using screen = await mount();

    expect(screen.container.textContent).toBe("");
    expect(header().elements()).toEqual([]);
  });

  it("starts collapsed, lists nothing, and expands to the root nodes", async () => {
    setup([
      python([
        { path: SITE_PACKAGES, label: "site-packages", kind: "site-packages" },
        { path: TYPESHED, label: "typeshed", kind: "stubs" },
      ]),
    ]);
    await using _screen = await mount();

    await expect.element(header()).toBeVisible();
    expect(treeRow("site-packages/")).toBeNull();
    expect(mocks.listings).toEqual([]);

    await expandSection();
    expect(treeRow("typeshed/")).not.toBeNull();
    // Nothing is listed until a root's own node opens.
    expect(mocks.listings).toEqual([]);
  });

  it("lists a root on expanding it, then a folder inside it, and opens a file by its absolute path", async () => {
    setup([python([{ path: SITE_PACKAGES, label: "site-packages", kind: "site-packages" }])]);
    await using _screen = await mount();
    await expandSection();

    treeRow("site-packages/")!.click();
    await vi.waitFor(() => expect(treeRow("site-packages/six.py")).not.toBeNull());
    expect(mocks.listings).toEqual([{ cwd: SITE_PACKAGES, directoryPath: "" }]);

    treeRow("site-packages/stripe/")!.click();
    await vi.waitFor(() => expect(treeRow("site-packages/stripe/_invoice.py")).not.toBeNull());
    expect(mocks.listings).toEqual([
      { cwd: SITE_PACKAGES, directoryPath: "" },
      { cwd: SITE_PACKAGES, directoryPath: "stripe" },
    ]);
    expect(treeRow("site-packages/stripe/api/deep.py")).toBeNull();

    treeRow("site-packages/stripe/_invoice.py")!.click();
    await vi.waitFor(() =>
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
      ).toEqual([expect.objectContaining({ id: `file:${SITE_PACKAGES}/stripe/_invoice.py` })]),
    );
  });

  it("shows a retry line when a folder fails to list, keeps the tree, and lists again on retry", async () => {
    setup([python([{ path: SITE_PACKAGES, label: "site-packages", kind: "site-packages" }])]);
    mocks.failing.add(`${SITE_PACKAGES}\n`);
    await using _screen = await mount();
    await expandSection();

    treeRow("site-packages/")!.click();
    await expect.element(retry()).toBeVisible();
    expect(treeRow("site-packages/")).not.toBeNull();
    expect(treeRow("site-packages/six.py")).toBeNull();

    mocks.failing.clear();
    await retry().click();
    await vi.waitFor(() => expect(treeRow("site-packages/six.py")).not.toBeNull());
    expect(retry().elements()).toEqual([]);
    expect(mocks.listings).toEqual([
      { cwd: SITE_PACKAGES, directoryPath: "" },
      { cwd: SITE_PACKAGES, directoryPath: "" },
    ]);
  });
});
