import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useImperativeHandle, type RefObject } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import {
  type ComposerImageAttachment,
  DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { reviewCommentContextReference } from "../../lib/composerContextRecords";
import { buildFileReviewComment } from "../../reviewCommentContext";
import type { ChatMessage } from "../../types";
import { toastManager } from "../ui/toast";
import { useComposerSend } from "./useComposerSend";

type SendInput = Parameters<typeof useComposerSend>[0];
type HookResult = ReturnType<typeof useComposerSend>;
type TurnResult = AsyncResult.AsyncResult<void, Error>;
interface StartedTurn {
  readonly input: {
    readonly dispatchMode: string;
    readonly message: {
      readonly text: string;
      readonly attachments: ReadonlyArray<unknown>;
      readonly context?: { readonly records: ReadonlyArray<{ readonly contextId: string }> };
    };
  };
}

const mocks = vi.hoisted(() => ({
  startTurn: vi.fn<(value: StartedTurn) => Promise<TurnResult>>(),
}));

// A mock that leaves a name out breaks every module that imports it, so these keep the rest.
vi.mock(import("../../state/use-orchestration-command"), async (original) => ({
  ...(await original()),
  useOrchestrationCommand: (() => mocks.startTurn) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettingsHydrated: () => true,
}));
vi.mock(import("../../state/peerLinks"), async (original) => ({
  ...(await original()),
  useLinkedEnvironments: () => new Map(),
}));
vi.mock(import("../../hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => async () => null) as never,
}));
vi.mock(import("../GitHubStarPrompt"), async (original) => ({
  ...(await original()),
  recordPromptSent: async () => {},
}));
vi.mock("./useMultipleModelSend", () => ({ useMultipleModelSend: () => async () => {} }));

const ENV = EnvironmentId.make("env-review-send");
const THREAD: ScopedThreadRef = { environmentId: ENV, threadId: ThreadId.make("thread-1") };
// Where the composer writes while a queued message is being edited.
const QUEUED_EDIT = DraftId.make("queued-edit-draft");
const ROUTE_KEY = `${ENV}:${THREAD.threadId}`;
const TYPED = "half a thought";
const IMAGE = {
  type: "image",
  id: "pasted",
  name: "pasted.png",
  mimeType: "image/png",
  sizeBytes: 1,
  previewUrl: "data:image/png;base64,AAAA",
  file: new File(["x"], "pasted.png", { type: "image/png" }),
} satisfies ComposerImageAttachment;

function comment(id: string) {
  return buildFileReviewComment({
    id,
    filePath: "src/app.ts",
    startLine: 1,
    endLine: 1,
    text: `note ${id}`,
    contents: "const answer = 42;\n",
  });
}

const referenceOf = (id: string) =>
  formatInlineContextReference(reviewCommentContextReference(comment(id)));
const draft = () => useComposerDraftStore.getState().getComposerDraft(THREAD);

interface Scenario {
  readonly dispatchMode?: "auto" | "queue" | "steer";
  readonly phase?: SendInput["phase"];
  readonly editingQueuedMessage?: boolean;
  readonly questionOpen?: boolean;
  readonly approvalWaiting?: boolean;
}

function setup(scenario: Scenario = {}) {
  mocks.startTurn.mockReset();
  mocks.startTurn.mockResolvedValue(AsyncResult.success(undefined));
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  const store = useComposerDraftStore.getState();
  store.setPrompt(THREAD, TYPED);
  store.addImage(THREAD, IMAGE);
  const optimistic: { messages: ChatMessage[] } = { messages: [] };
  const saveQueuedEdit = vi.fn(async () => {});
  const advanceQuestion = vi.fn();
  const respondToApproval = vi.fn(async () => {});
  const approvals = scenario.approvalWaiting
    ? [{ requestId: "approval-1", supportsFeedback: false }]
    : [];
  // Stands in for the composer: it reports the whole draft, as the real one does.
  const composer = {
    getSendContext: () => ({
      answeringPendingUserInput: scenario.questionOpen === true,
      shownPendingApprovalIds: approvals.map((approval) => approval.requestId),
      prompt: draft()?.prompt ?? "",
      images: draft()?.images ?? [],
      files: [],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: draft()?.reviewComments ?? [],
      threadContexts: [],
      environmentContexts: [],
      selectedPromptEffort: null,
      selectedModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      multipleModelSelections: null,
      providerAvailable: true,
      selectedProvider: "codex",
      selectedModel: "gpt-5.4",
      selectedProviderModels: [],
      dispatchMode: scenario.dispatchMode ?? "auto",
    }),
    validateProviderInput: () => true,
    resetCursorState: vi.fn(),
    hasPendingAttachments: () => false,
  };
  const input = {
    environmentId: ENV,
    routeThreadKey: ROUTE_KEY,
    currentRouteThreadKeyRef: { current: ROUTE_KEY },
    draftId: null,
    draftThread: null,
    activeThread: {
      id: THREAD.threadId,
      environmentId: ENV,
      worktreePath: null,
      createdAt: "2026-11-11T00:00:00.000Z",
      activeProviderThreadId: null,
    },
    activeThreadKey: ROUTE_KEY,
    activeThreadBranch: null,
    activeProject: { id: ProjectId.make("project-1"), environmentId: ENV, workspaceRoot: "/repo" },
    activeProjectDefaultModelSelection: null,
    activeMessageCount: 2,
    isServerThread: true,
    isLocalDraftThread: false,
    isGitRepo: true,
    phase: scenario.phase ?? "ready",
    runtimeMode: "full-access",
    sendEnvMode: "local",
    startFromOrigin: false,
    localCheckoutBranchMismatch: null,
    logicalProjectEnvironments: [],
    providerInstanceEntries: [],
    composerRef: { current: composer },
    composerDraftTarget: scenario.editingQueuedMessage ? QUEUED_EDIT : THREAD,
    threadDraftTarget: THREAD,
    promptRef: { current: TYPED },
    composerImagesRef: { current: [IMAGE] },
    composerFilesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    feedbackUploadsInFlightRef: { current: new Set<string>() },
    queuedRunEdit: { isEditing: scenario.editingQueuedMessage === true, saveEdit: saveQueuedEdit },
    isRevertingCheckpoint: false,
    threadDetailLoading: false,
    activeEnvironmentUnavailable: false,
    isSendBusy: false,
    sendQueuesBehindSetup: false,
    isDraftHeroState: false,
    panelAnimationsActive: false,
    panelAnimationDurationMs: 0,
    keepFullHistory: false,
    freshSessionAvailable: false,
    resumeCompactionTokens: null,
    usageLimitsKey: null,
    usageLimitsOffered: false,
    openUsageLimits: () => false,
    clearUsageLimitsFor: () => {},
    needsLoadBalancing: false,
    loadBalancing: { pending: false },
    readPendingEnvironmentChange: () => null,
    pendingApprovals: approvals,
    respondingRequestIds: [],
    activePendingProgress: scenario.questionOpen ? { questionIndex: 0 } : null,
    onAdvanceActivePendingUserInput: advanceQuestion,
    onRespondToApproval: respondToApproval,
    beginLocalDispatch: () => {},
    resetLocalDispatch: () => {},
    beginWorktreeSetup: () => {},
    captureDraftHeroComposerRect: () => {},
    setDockedDraftHeroThreadKey: () => {},
    setSetupQueueSendThreadKey: () => {},
    setOptimisticUserMessages: (
      action: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[]),
    ) => {
      optimistic.messages = typeof action === "function" ? action(optimistic.messages) : action;
    },
    optimisticBlobPreviews: { track: () => {}, release: () => {} },
    setFeedbackSubmissionsByThreadKey: () => {},
    setThreadError: () => {},
    setKeepFullHistory: () => {},
    anchorNewTurn: () => {},
    acknowledgeActiveThreadWoke: () => {},
    sideChatDisabledReason: null,
    handleNewThreadInActiveProject: () => {},
    persistThreadSettingsForNextTurn: async () => AsyncResult.success(undefined),
  } as unknown as SendInput;
  return {
    input,
    hook: { current: null as HookResult | null },
    optimistic,
    saveQueuedEdit,
    advanceQuestion,
    respondToApproval,
  };
}

function Harness(props: { input: SendInput; hookRef: RefObject<HookResult | null> }) {
  const result = useComposerSend(props.input);
  useImperativeHandle(props.hookRef, () => result);
  return null;
}

function send(hook: { current: HookResult | null }, ids: ReadonlyArray<string>) {
  if (!hook.current) throw new Error("hook did not render");
  return hook.current.sendReviewComments(ids.map(comment));
}

const sentMessage = () => mocks.startTurn.mock.calls[0]?.[0].input.message;
const sentRecordIds = () => sentMessage()?.context?.records.map((record) => record.contextId);
const recordIdOf = (id: string) => reviewCommentContextReference(comment(id)).contextId;

describe("review sends", () => {
  it("sends one comment alone and leaves the rest of the draft where it is", async () => {
    const { input, hook, optimistic } = setup();
    const store = useComposerDraftStore.getState();
    store.addReviewComment(THREAD, comment("waiting-1"));
    store.addReviewComment(THREAD, comment("waiting-2"));
    const before = draft();
    await using _screen = await render(<Harness input={input} hookRef={hook} />);

    await expect(send(hook, ["now"])).resolves.toEqual({ status: "dispatched" });

    expect(mocks.startTurn).toHaveBeenCalledTimes(1);
    expect(sentRecordIds()).toEqual([recordIdOf("now")]);
    expect(sentMessage()?.text).toBe(referenceOf("now"));
    expect(sentMessage()?.attachments).toEqual([]);
    expect(mocks.startTurn.mock.calls[0]?.[0].input.dispatchMode).toBe("auto");
    expect(optimistic.messages).toHaveLength(1);
    // Typed text, the pasted image and the two comments that were only added to the message.
    expect(draft()).toEqual(before);
  });

  it("Send all sends the waiting comments and keeps the typed text", async () => {
    const { input, hook } = setup();
    const store = useComposerDraftStore.getState();
    store.addReviewComment(THREAD, comment("waiting-1"));
    store.addReviewComment(THREAD, comment("waiting-2"));
    await using _screen = await render(<Harness input={input} hookRef={hook} />);

    await expect(send(hook, ["waiting-1", "waiting-2"])).resolves.toEqual({ status: "dispatched" });

    expect(sentRecordIds()).toEqual([recordIdOf("waiting-1"), recordIdOf("waiting-2")]);
    expect(sentMessage()?.text).not.toContain(TYPED);
    expect(draft()?.reviewComments).toEqual([]);
    expect(draft()?.prompt).toBe(TYPED);
    expect(draft()?.images).toHaveLength(1);
  });

  it("keeps the comments and says why when the dispatch fails", async () => {
    const { input, hook, optimistic } = setup();
    useComposerDraftStore.getState().addReviewComment(THREAD, comment("waiting-1"));
    const before = draft();
    mocks.startTurn.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Server said no"))));
    using toast = vi.spyOn(toastManager, "add");
    await using _screen = await render(<Harness input={input} hookRef={hook} />);

    await expect(send(hook, ["waiting-1"])).resolves.toEqual({
      status: "failed",
      reason: "Server said no",
    });

    expect(draft()).toEqual(before);
    expect(optimistic.messages).toEqual([]);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        description: expect.stringContaining("Server said no"),
      }),
    );
  });

  it.each([
    {
      name: "a queued message is being edited",
      scenario: { editingQueuedMessage: true },
      reason: "Finish editing the queued message first.",
    },
    {
      name: "a question from the agent is open",
      scenario: { questionOpen: true },
      reason: "Answer the agent's question first.",
    },
    {
      name: "an approval is waiting",
      scenario: { approvalWaiting: true },
      reason: "Answer the pending approval first.",
    },
  ])("refuses while $name", async ({ scenario, reason }) => {
    const { input, hook, saveQueuedEdit, advanceQuestion, respondToApproval } = setup(scenario);
    using toast = vi.spyOn(toastManager, "add");
    await using _screen = await render(<Harness input={input} hookRef={hook} />);

    await expect(send(hook, ["now"])).resolves.toEqual({ status: "refused", reason });

    expect(mocks.startTurn).not.toHaveBeenCalled();
    // The comment must not land in the queued message, answer the question or decline the approval.
    expect(saveQueuedEdit).not.toHaveBeenCalled();
    expect(advanceQuestion).not.toHaveBeenCalled();
    expect(respondToApproval).not.toHaveBeenCalled();
    // It waits in the thread's own message, beside what was typed there, where no edit discards it.
    expect(draft()?.reviewComments.map((kept) => kept.id)).toEqual(["now"]);
    expect(draft()?.prompt).toBe(`${TYPED} ${referenceOf("now")} `);
    expect(draft()?.images).toHaveLength(1);
    expect(useComposerDraftStore.getState().getComposerDraft(QUEUED_EDIT)).toBeNull();
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining(reason) }),
    );
  });

  it("refuses a second send while the first is still going out", async () => {
    const { input, hook } = setup();
    let finishFirst!: (result: TurnResult) => void;
    mocks.startTurn.mockReturnValueOnce(
      new Promise<TurnResult>((resolve) => {
        finishFirst = resolve;
      }),
    );
    await using _screen = await render(<Harness input={input} hookRef={hook} />);

    const firstSend = send(hook, ["first"]);
    await expect(send(hook, ["second"])).resolves.toEqual({
      status: "refused",
      reason: "Another message is still being sent.",
    });
    finishFirst(AsyncResult.success(undefined));

    await expect(firstSend).resolves.toEqual({ status: "dispatched" });
    expect(mocks.startTurn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { preference: "queue", outcome: { status: "queued" } },
    { preference: "steer", outcome: { status: "dispatched" } },
  ] as const)("goes into a running turn by the $preference preference", async (row) => {
    const { input, hook } = setup({ phase: "running", dispatchMode: row.preference });
    await using _screen = await render(<Harness input={input} hookRef={hook} />);

    await expect(send(hook, ["now"])).resolves.toEqual(row.outcome);

    expect(mocks.startTurn.mock.calls[0]?.[0].input.dispatchMode).toBe(row.preference);
  });
});

describe("annotation sends", () => {
  it("still send the whole draft and clear it", async () => {
    const { input, hook } = setup();
    await using _screen = await render(<Harness input={input} hookRef={hook} />);
    const annotation = {
      id: "picked",
      pageUrl: "http://localhost:5173/",
      pageTitle: null,
      comment: "tighten this",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "2026-11-11T00:00:00.000Z",
    };
    useComposerDraftStore.getState().addPreviewAnnotation(THREAD, annotation);

    await hook.current?.onSend(undefined, "auto", "foreground", {
      kind: "preview-annotation",
      annotation,
      image: null,
    });

    expect(sentMessage()?.text).toContain(TYPED);
    expect(sentMessage()?.attachments).toHaveLength(1);
    expect(draft()?.prompt ?? "").toBe("");
    expect(draft()?.images ?? []).toEqual([]);
  });
});
