// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Owns Playwright resources and their idle timer outside the Effect runtime.
import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Browser, BrowserContext, CDPSession } from "playwright-core";

import { sandboxDisabled } from "./PreviewBrowserHost.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

interface Options {
  readonly profilesDir: string;
  readonly executable: () => Promise<string>;
  /**
   * A path that starts `executable`, such as one that moves Chrome out of the server's cgroup.
   * Released after the whole launch call, since Playwright retries the same path after a glibc race.
   */
  readonly launcher?: (
    executable: string,
  ) => Promise<{ readonly path: string; readonly release: () => Promise<void> } | undefined>;
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  /** Closes the shared browser once it has held no context for this long. */
  readonly idleBrowserMs?: number;
  readonly onContextClose?: (context: BrowserContext) => void;
  /** A hosted browser that takes per-tab contexts for the pages it can reach. */
  readonly remote?: {
    /** Where to connect, or undefined while it is off. */
    readonly endpoint: () => Promise<
      { readonly url: string; readonly headers: Readonly<Record<string, string>> } | undefined
    >;
    readonly reaches: (url: string) => Promise<boolean>;
    /** It ends a browser that gets no command for a while. */
    readonly heartbeatMs: number;
    /** A connection failed; the context opens in the local browser instead. */
    readonly onUnavailable?: (cause: unknown) => void;
  };
}

const REMOTE_CONNECT_TIMEOUT_MS = 10_000;
const END_TIMEOUT_MS = 3_000;
/** After a failed connection, how long tabs skip the remote browser rather than each waiting on it. */
const REMOTE_RETRY_MS = 60_000;

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/** Change user agent and Sec-CH-UA together; sites block mismatches. */
const chromeIdentity = (
  headlessUserAgent: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release: string },
) => {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  const brands = (names: (version: string) => string) => [
    { brand: "Chromium", version: names(major) },
    { brand: "Google Chrome", version: names(major) },
    { brand: "Not A(Brand", version: names("99") },
  ];
  return {
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platform === "linux" ? host.release : "",
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
};

export const presentAsChrome = async (
  cdp: CDPSession,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release?: string },
) => {
  const { userAgent } = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(userAgent, {
    ...host,
    release: host.release ?? NodeOS.release(),
  });
  if (identity) await cdp.send("Emulation.setUserAgentOverride", identity);
};

/** One lazily started browser whose contexts come and go; it closes once it has held none for a while. */
class SharedBrowser {
  private readonly idleMs: number | undefined;
  private readonly end: (browser: Browser) => Promise<void>;
  private readonly open = new Set<BrowserContext>();
  private browser: Promise<Browser> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private pending = 0;
  private closed = false;

  /** `end` stops the browser before the connection to it closes. */
  constructor(
    idleMs: number | undefined,
    end: (browser: Browser) => Promise<void> = async () => {},
  ) {
    this.idleMs = idleMs;
    this.end = end;
  }

  owns(context: BrowserContext) {
    return this.open.has(context);
  }

  async newContext(options: Parameters<Browser["newContext"]>[0], start: () => Promise<Browser>) {
    clearTimeout(this.idleTimer);
    this.pending++;
    const started = this.started(start);
    try {
      const context = await (await started).newContext(options);
      this.open.add(context);
      context.on("close", () => {
        this.open.delete(context);
        this.retireWhenIdle(started);
      });
      return context;
    } finally {
      this.pending--;
      this.retireWhenIdle(started);
    }
  }

  /** Starts the browser without a context; it still closes when it stays idle. */
  async ready(start: () => Promise<Browser>) {
    const started = this.started(start);
    try {
      await started;
    } finally {
      this.retireWhenIdle(started);
    }
  }

  private started(start: () => Promise<Browser>) {
    if (!this.browser) {
      const started = start().then((browser) => {
        browser.on("disconnected", () => {
          if (this.browser === started) this.browser = undefined;
        });
        return browser;
      });
      this.browser = started;
      void started.catch(() => {
        if (this.browser === started) this.browser = undefined;
      });
    }
    return this.browser;
  }

  private retireWhenIdle(started: Promise<Browser>) {
    if (this.idleMs === undefined || this.closed || this.pending > 0) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.retire(started), this.idleMs);
    this.idleTimer.unref();
  }

  private async retire(started: Promise<Browser>) {
    const browser = await started.catch(() => undefined);
    if (!browser || this.browser !== started || this.pending > 0 || this.open.size > 0) return;
    // Cleared first, so a request during the close starts a fresh browser.
    this.browser = undefined;
    await this.stop(browser);
  }

  private async stop(browser: Browser) {
    // A connection that died without closing never answers, and must not hold up a shutdown.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.end(browser).catch(constVoid),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, END_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    await browser.close().catch(constVoid);
  }

  async close() {
    this.closed = true;
    clearTimeout(this.idleTimer);
    const browser = await this.browser?.catch(() => undefined);
    if (browser) await this.stop(browser);
  }
}

export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  private readonly clearing = new Map<string, Promise<void>>();
  private readonly local: SharedBrowser;
  private readonly remote: SharedBrowser;
  private remoteDown = false;
  private closing: Promise<void> | undefined;

  constructor(options: Options) {
    this.options = options;
    this.local = new SharedBrowser(options.idleBrowserMs);
    // Disconnecting leaves a hosted browser running, and billed, until it times out.
    this.remote = new SharedBrowser(options.idleBrowserMs, async (browser) => {
      const session = await browser.newBrowserCDPSession();
      await session.send("Browser.close");
    });
  }

  private async launchOptions() {
    const executable = await this.options.executable();
    const env = this.options.env ?? process.env;
    return {
      executable,
      env,
      args: [
        "--disable-gpu",
        "--force-device-scale-factor=2",
        "--disable-blink-features=AutomationControlled",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      headless: true,
      // Only an explicit operator opt-out disables sandboxing. Launch errors never do.
      chromiumSandbox: !sandboxDisabled(env),
    };
  }

  private async launch<A>(executable: string, start: (executablePath: string) => Promise<A>) {
    let release: (() => Promise<void>) | undefined;
    try {
      const launcher = await this.options.launcher?.(executable);
      release = launcher?.release;
      return await start(launcher?.path ?? executable);
    } catch (cause) {
      throw (await this.options.diagnose?.(executable, cause)) ?? cause;
    } finally {
      await release?.().catch(constVoid);
    }
  }

  private async launchShared() {
    const { executable, ...options } = await this.launchOptions();
    const { chromium } = loadPlaywright();
    return this.launch(executable, (executablePath) =>
      chromium.launch({ ...options, executablePath }),
    );
  }

  /** How to start the remote browser for `url`, or undefined when the page has to load in the local one. */
  private async remoteStart(url: string) {
    const remote = this.options.remote;
    if (!remote || this.remoteDown) return undefined;
    const endpoint = await remote.endpoint();
    if (!endpoint || !(await remote.reaches(url))) return undefined;
    return async () => {
      const browser = await loadPlaywright().chromium.connectOverCDP(endpoint.url, {
        headers: { ...endpoint.headers },
        timeout: REMOTE_CONNECT_TIMEOUT_MS,
      });
      const session = await browser.newBrowserCDPSession();
      const heartbeat = setInterval(
        () => void session.send("Browser.getVersion").catch(constVoid),
        remote.heartbeatMs,
      );
      heartbeat.unref();
      browser.on("disconnected", () => clearInterval(heartbeat));
      return browser;
    };
  }

  // Tabs opening together share one failed connection: one report, one wait.
  private remoteFailed(cause: unknown) {
    if (this.remoteDown) return;
    this.remoteDown = true;
    setTimeout(() => {
      this.remoteDown = false;
    }, REMOTE_RETRY_MS).unref();
    this.options.remote?.onUnavailable?.(cause);
  }

  /**
   * Whether the remote browser will take a tab for `url`, connecting to it now. A caller that
   * gives up something for a remote tab, such as a profile's logins, asks before it does.
   */
  async remoteTakes(url: string) {
    const start = await this.remoteStart(url);
    if (!start) return false;
    try {
      await this.remote.ready(start);
      return true;
    } catch (cause) {
      this.remoteFailed(cause);
      return false;
    }
  }

  private async remoteContext(options: Parameters<Browser["newContext"]>[0], url: string) {
    const start = await this.remoteStart(url);
    if (!start) return undefined;
    try {
      return await this.remote.newContext(options, start);
    } catch (cause) {
      this.remoteFailed(cause);
      return undefined;
    }
  }

  /** Whether the context runs in the remote browser, which reaches public addresses only. */
  isRemote(context: BrowserContext) {
    return this.remote.owns(context);
  }

  /** `url` is the page a per-tab context opens with; it picks the browser that can reach it. */
  contextFor(profileId: string, isolationKey?: string, url?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const key = JSON.stringify([profileId, isolationKey ?? null]);
    const cached = this.contexts.get(key);
    if (cached) return cached;
    const cleared = this.clearing.get(key)?.catch(constVoid) ?? Promise.resolve();
    const pending = cleared
      .then(() => this.createContext(profileId, isolationKey, url))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
        });
        for (const page of context.pages()) await page.close().catch(constVoid);
        if (this.closing) {
          await context.close().catch(constVoid);
          throw new Error("The preview browser is closed.");
        }
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  private async createContext(profileId: string, isolationKey?: string, url?: string) {
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
    if (isolationKey !== undefined || profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      // A context without a key would be shared by tabs that may need different browsers.
      const remote =
        isolationKey !== undefined && url !== undefined
          ? await this.remoteContext(contextOptions, url)
          : undefined;
      return remote ?? this.local.newContext(contextOptions, () => this.launchShared());
    }
    const directory = this.profileDirectory(profileId);
    await NodeFSP.mkdir(directory, { recursive: true });
    const { executable, ...options } = await this.launchOptions();
    const { chromium } = loadPlaywright();
    return this.launch(executable, (executablePath) =>
      chromium.launchPersistentContext(directory, {
        ...options,
        ...contextOptions,
        executablePath,
      }),
    );
  }

  private profileDirectory(profileId: string) {
    const encoded = encodeURIComponent(profileId);
    return NodePath.join(
      this.options.profilesDir,
      profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
    );
  }

  async scratchPage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    const context = await this.local.newContext(undefined, () => this.launchShared());
    const page = await context.newPage();
    page.once("close", () => void context.close().catch(constVoid));
    return page;
  }

  async connectDesktopPage(endpoint: string) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close().catch(constVoid);
      throw new Error("The desktop tab has no page.");
    }
    return { browser, page };
  }

  async clearProfile(profileId: string) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    const key = JSON.stringify([profileId, null]);
    const existing = this.clearing.get(key);
    if (existing) return existing;
    const clearing = (async () => {
      const pending = this.contexts.get(key);
      if (pending) {
        this.contexts.delete(key);
        const context = await pending.catch(() => undefined);
        await context?.close();
      }
      await NodeFSP.rm(this.profileDirectory(profileId), { recursive: true, force: true });
    })();
    this.clearing.set(key, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(key) === clearing) this.clearing.delete(key);
    }
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    await Promise.allSettled(
      [...this.contexts.values()].map(async (pending) => (await pending).close()),
    );
    await Promise.all([this.local.close(), this.remote.close()]);
    this.contexts.clear();
  }
}
