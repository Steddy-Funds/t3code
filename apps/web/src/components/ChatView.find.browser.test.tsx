import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { isMacPlatform } from "~/lib/utils";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// Its own file: the app's config subscription outlives a test, and it must have thread find on.
it("leaves Mod+F in the side-by-side diff's find field to that field", async () => {
  using _environment = installFakeEnvironment([threadWithHistory("find", 1)], { threadFind: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/find`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("Answer 0 for find.")).toBeVisible();
  const modF = isMacPlatform(navigator.platform) ? "{Meta>}f{/Meta}" : "{Control>}f{/Control}";

  // Stands in for the find bar of SideBySideDiffView, which needs a loaded turn diff around it.
  const bar = document.body.appendChild(document.createElement("div"));
  using _bar = { [Symbol.dispose]: () => bar.remove() };
  bar.setAttribute("data-sbs-find", "");
  const field = bar.appendChild(document.createElement("input"));
  const reached: string[] = [];
  field.addEventListener("keydown", (event) => reached.push(event.key));
  field.focus();
  await userEvent.keyboard(modF);
  expect(reached).toContain("f");

  // Anywhere else in the thread, the same key opens the thread's find.
  field.blur();
  await userEvent.keyboard(modF);
  await expect.element(page.getByRole("searchbox", { name: "Find in thread" })).toBeVisible();
});
