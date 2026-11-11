import { KeybindingCommand, KeybindingRule, KeybindingsConfig } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as SharedKeybindings from "@t3tools/shared/keybindings";
import { KeybindingsConfigError, MAX_KEYBINDINGS_COUNT } from "@t3tools/contracts";

const KeybindingsConfigJson = Schema.fromJsonString(KeybindingsConfig);
const encodeKeybindingsConfigJson = Schema.encodeEffect(KeybindingsConfigJson);
const decodeKeybindingsConfigJson = Schema.decodeUnknownEffect(KeybindingsConfigJson);
const layerKeybindings = () => {
  return Keybindings.layer.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-keybindings-test-",
        }),
      ),
    ),
  );
};

const toDetailResult = <A, R>(effect: Effect.Effect<A, KeybindingsConfigError, R>) =>
  effect.pipe(
    Effect.mapError((error) => error.detail),
    Effect.result,
  );

const writeKeybindingsConfig = (configPath: string, rules: readonly KeybindingRule[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const encoded = yield* encodeKeybindingsConfigJson(rules);
    yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
    yield* fileSystem.writeFileString(configPath, encoded);
  });

const readKeybindingsConfig = (configPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rawConfig = yield* fileSystem.readFileString(configPath);
    return yield* decodeKeybindingsConfigJson(rawConfig);
  });

it.layer(NodeServices.layer)("keybindings", (it) => {
  it.effect("parses shortcuts including plus key", () =>
    Effect.sync(() => {
      assert.deepEqual(SharedKeybindings.parseKeybindingShortcut("mod+j"), {
        key: "j",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      });
      assert.deepEqual(SharedKeybindings.parseKeybindingShortcut("mod++"), {
        key: "+",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      });
    }),
  );

  it.effect("compiles valid rule with parsed when AST", () =>
    Effect.sync(() => {
      const compiled = SharedKeybindings.compileResolvedKeybindingRule({
        key: "mod+d",
        command: "terminal.split",
        when: "terminalOpen && !terminalFocus",
      });

      assert.deepEqual(compiled, {
        command: "terminal.split",
        shortcut: {
          key: "d",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
        whenAst: {
          type: "and",
          left: { type: "identifier", name: "terminalOpen" },
          right: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      });
    }),
  );

  it.effect("rejects invalid rules", () =>
    Effect.sync(() => {
      assert.isNull(
        SharedKeybindings.compileResolvedKeybindingRule({
          key: "mod+shift+d+o",
          command: "terminal.new",
        }),
      );

      assert.isNull(
        SharedKeybindings.compileResolvedKeybindingRule({
          key: "mod+d",
          command: "terminal.split",
          when: "terminalFocus && (",
        }),
      );

      assert.isNull(
        SharedKeybindings.compileResolvedKeybindingRule({
          key: "mod+d",
          command: "terminal.split",
          when: `${"!".repeat(300)}terminalFocus`,
        }),
      );
    }),
  );

  it.effect("bootstraps default keybindings when config file is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      assert.isFalse(yield* fs.exists(keybindingsConfigPath));

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(persisted, SharedKeybindings.DEFAULT_KEYBINDINGS);

      const written = yield* fs.readFileString(keybindingsConfigPath);
      yield* (yield* Keybindings.Keybindings).syncDefaultKeybindingsOnStartup;
      assert.equal(yield* fs.readFileString(keybindingsConfigPath), written);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("uses defaults in runtime when config is malformed without overriding file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(
        configState.keybindings,
        SharedKeybindings.compileResolvedKeybindingsConfig(SharedKeybindings.DEFAULT_KEYBINDINGS),
      );
      assert.deepEqual(configState.issues, [
        {
          kind: "keybindings.malformed-config",
          message: configState.issues[0]?.message ?? "",
        },
      ]);
      assert.equal(yield* fs.readFileString(keybindingsConfigPath), "{ not-json");
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("ignores invalid entries in runtime and reports them as issues", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([
          { key: "mod+j", command: "terminal.toggle" },
          { key: "mod+shift+d+o", command: "terminal.new" },
          { key: "mod+x", command: "invalid.command" },
        ]),
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.isTrue(configState.keybindings.some((entry) => entry.command === "terminal.toggle"));
      assert.isFalse(
        configState.keybindings.some((entry) => String(entry.command) === "invalid.command"),
      );
      assert.deepEqual(configState.issues, [
        {
          kind: "keybindings.invalid-entry",
          index: 1,
          message: configState.issues[0]?.message ?? "",
        },
        {
          kind: "keybindings.invalid-entry",
          index: 2,
          message: configState.issues[1]?.message ?? "",
        },
      ]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect(
    "upserts missing default keybindings on startup without overriding existing command rules",
    () =>
      Effect.gen(function* () {
        const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
        yield* writeKeybindingsConfig(keybindingsConfigPath, [
          { key: "mod+shift+y", command: "terminal.toggle" },
          { key: "mod+shift+r", command: "script.run-tests.run" },
          { key: "mod+shift+b", command: "script.custom-panel.run" },
          {
            key: "mod+shift+b",
            command: "script.custom-composer.run",
            when: "composerFocus",
          },
        ]);

        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;

        const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
        const byCommand = new Map(persisted.map((entry) => [entry.command, entry]));

        const persistedToggle = byCommand.get("terminal.toggle");
        assert.isNotNull(persistedToggle);
        assert.equal(persistedToggle?.key, "mod+shift+y");
        assert.isFalse(
          persisted.some((entry) => entry.command === "terminal.toggle" && entry.key === "mod+j"),
        );

        for (const defaultRule of SharedKeybindings.DEFAULT_KEYBINDINGS) {
          assert.isTrue(byCommand.has(defaultRule.command), `expected ${defaultRule.command}`);
        }
        assert.isTrue(byCommand.has("script.run-tests.run"));

        const configState = yield* keybindings.loadConfigState;
        assert.deepEqual(
          configState.keybindings
            .filter((entry) => entry.shortcut.key === "b" && entry.shortcut.shiftKey)
            .map((entry) => entry.command),
          [
            "threadPanel.toggle",
            "code.goToTypeDeclaration",
            "script.custom-panel.run",
            "script.custom-composer.run",
          ],
        );
      }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("adds a late default to an existing command once", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const when = "composerFocus && draftThreadRoute";
      const existing = { key: "mod+alt+enter", command: "composer.sendBackground", when } as const;
      const backgroundRules = Effect.map(readKeybindingsConfig(keybindingsConfigPath), (rules) =>
        rules.filter((entry) => entry.command === "composer.sendBackground"),
      );
      yield* writeKeybindingsConfig(keybindingsConfigPath, [existing]);

      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.deepStrictEqual(yield* backgroundRules, [
        { key: "mod+enter", command: "composer.sendBackground", when },
        existing,
      ]);

      yield* writeKeybindingsConfig(keybindingsConfigPath, [existing]);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.deepStrictEqual(yield* backgroundRules, [existing]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("leaves a customized command without the late default", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const custom = {
        key: "alt+b",
        command: "composer.sendBackground",
        when: "composerFocus && draftThreadRoute",
      } as const;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [custom]);

      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepStrictEqual(
        persisted.filter((entry) => entry.command === "composer.sendBackground"),
        [custom],
      );
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("keeps a late default pending while the config is full", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const when = "composerFocus && draftThreadRoute";
      const existing = { key: "mod+alt+enter", command: "composer.sendBackground", when } as const;
      const fillers = Array.from({ length: MAX_KEYBINDINGS_COUNT - 1 }, (_, index) => ({
        key: "mod+alt+f1",
        command: `script.filler-${index}.run` as const,
      }));
      const hasModEnter = Effect.map(readKeybindingsConfig(keybindingsConfigPath), (rules) =>
        rules.some(
          (entry) => entry.command === "composer.sendBackground" && entry.key === "mod+enter",
        ),
      );

      yield* writeKeybindingsConfig(keybindingsConfigPath, [existing, ...fillers]);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.isFalse(yield* hasModEnter);

      yield* writeKeybindingsConfig(keybindingsConfigPath, [existing]);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.isTrue(yield* hasModEnter);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("skips conflicting default keybindings on startup and logs a detailed warning", () => {
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });

    return Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "script.custom-action.run" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isFalse(persisted.some((entry) => entry.command === "terminal.toggle"));
      assert.isTrue(persisted.some((entry) => entry.command === "script.custom-action.run"));

      assert.isTrue(
        messages.some((message) =>
          message.includes("skipping default keybinding due to shortcut conflict"),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(layerKeybindings(), Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  // The last rule on a shortcut wins, so it names what the shortcut runs where its condition holds.
  const topCommand = (rules: readonly KeybindingRule[], key: string) =>
    rules.findLast((rule) => rule.key === key)?.command;
  const isSameRule = (left: KeybindingRule, right: KeybindingRule) =>
    left.key === right.key && left.command === right.command && left.when === right.when;
  const withoutAdded = (rules: readonly KeybindingRule[], before: readonly KeybindingRule[]) =>
    rules.filter((rule) => before.some((entry) => isSameRule(entry, rule)));
  const syncExisting = (rules: readonly KeybindingRule[]) =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      yield* writeKeybindingsConfig(keybindingsConfigPath, rules);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      return yield* readKeybindingsConfig(keybindingsConfigPath);
    });

  it.effect("ranks new scoped defaults above the defaults an existing config holds", () =>
    Effect.gen(function* () {
      const persisted = yield* syncExisting(EXISTING_INSTALL_KEYBINDINGS);

      assert.deepStrictEqual(
        withoutAdded(persisted, EXISTING_INSTALL_KEYBINDINGS),
        EXISTING_INSTALL_KEYBINDINGS,
      );
      assert.sameDeepMembers([...persisted], [...SharedKeybindings.DEFAULT_KEYBINDINGS]);
      for (const [key, scoped, earlier] of [
        ["mod+b", "code.goToDeclaration", "sidebar.toggle"],
        ["mod+shift+b", "code.goToTypeDeclaration", "threadPanel.toggle"],
        ["mod+alt+b", "code.goToImplementation", "rightPanel.toggle"],
        ["mod+l", "code.goToLine", "preview.focusUrl"],
        ["mod+o", "code.goToClass", "editor.openFavorite"],
        ["mod+shift+o", "filePicker.toggle", "chat.new"],
        ["mod+1", "projectPane.toggle", "modelPicker.jump.1"],
      ] as const) {
        assert.equal(topCommand(persisted, key), scoped);
        // Each lands right after the rule it refines, not at the end of the file.
        const index = persisted.findIndex((rule) => rule.key === key && rule.command === scoped);
        assert.equal(persisted[index - 1]?.command, earlier);
      }

      const { keybindings } = yield* (yield* Keybindings.Keybindings).loadConfigState;
      assert.deepStrictEqual(
        keybindings,
        SharedKeybindings.compileResolvedKeybindingsConfig(persisted),
      );
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("keeps a rule the user wrote above the defaults it adds", () =>
    Effect.gen(function* () {
      const userRules = [
        { key: "mod+b", command: "chat.newLocal" },
        { key: "mod+shift+o", command: "script.open-notes.run" },
      ] as const;
      const existing = [...EXISTING_INSTALL_KEYBINDINGS, ...userRules];
      const persisted = yield* syncExisting(existing);

      assert.deepStrictEqual(withoutAdded(persisted, existing), existing);
      assert.equal(topCommand(persisted, "mod+b"), "chat.newLocal");
      assert.equal(topCommand(persisted, "mod+shift+o"), "script.open-notes.run");
      assert.isTrue(persisted.some((rule) => rule.command === "code.goToDeclaration"));
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("restores a removed default below the scoped default on its shortcut", () =>
    Effect.gen(function* () {
      const persisted = yield* syncExisting(
        EXISTING_INSTALL_KEYBINDINGS.filter((rule) => rule.command !== "sidebar.toggle"),
      );
      const onModB = persisted.filter((rule) => rule.key === "mod+b").map((rule) => rule.command);

      assert.deepStrictEqual(onModB, ["sidebar.toggle", "code.goToDeclaration"]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("adds the extra shortcuts of existing commands once", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const extras = [
        { key: "mod+shift+o", command: "filePicker.toggle", when: "codeFocus || projectTreeFocus" },
        {
          key: "mod+alt+arrowleft",
          command: "navigation.back",
          when: "!terminalFocus && isDesktop",
        },
        {
          key: "mod+alt+arrowright",
          command: "navigation.forward",
          when: "!terminalFocus && isDesktop",
        },
      ] as const;
      const isExtra = (rule: KeybindingRule) => extras.some((extra) => isSameRule(extra, rule));

      const migrated = yield* syncExisting(EXISTING_INSTALL_KEYBINDINGS);
      assert.sameDeepMembers(migrated.filter(isExtra), [...extras]);

      const written = yield* fs.readFileString(keybindingsConfigPath);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.equal(yield* fs.readFileString(keybindingsConfigPath), written);

      // Removing one is the user's choice: its command still has a rule, so it stays removed.
      const trimmed = migrated.filter((rule) => !isExtra(rule));
      assert.deepStrictEqual(yield* syncExisting(trimmed), trimmed);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("adds nothing to a full config, then migrates it once there is room", () =>
    Effect.gen(function* () {
      const fillers = Array.from(
        { length: MAX_KEYBINDINGS_COUNT - EXISTING_INSTALL_KEYBINDINGS.length },
        (_, index) => ({ key: "mod+alt+f9", command: `script.filler-${index}.run` as const }),
      );
      const full = [...EXISTING_INSTALL_KEYBINDINGS, ...fillers];

      assert.deepStrictEqual(yield* syncExisting(full), full);

      const persisted = yield* syncExisting(EXISTING_INSTALL_KEYBINDINGS);
      assert.equal(topCommand(persisted, "mod+b"), "code.goToDeclaration");
      assert.equal(topCommand(persisted, "mod+shift+o"), "filePicker.toggle");
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("leaves a config with issues unwritten and still ranks the scoped defaults", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const written = JSON.stringify([
        { key: "mod+alt+arrowup", command: "thread.fromAnotherBuild" },
        ...EXISTING_INSTALL_KEYBINDINGS,
      ]);
      yield* fs.writeFileString(keybindingsConfigPath, written);

      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.equal(yield* fs.readFileString(keybindingsConfigPath), written);

      const state = yield* keybindings.loadConfigState;
      assert.lengthOf(state.issues, 1);
      const modB = SharedKeybindings.parseKeybindingShortcut("mod+b");
      assert.equal(
        state.keybindings.findLast((rule) => Equal.equals(rule.shortcut, modB))?.command,
        "code.goToDeclaration",
      );
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("appends additional custom keybindings for the same command", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("replaces only the targeted custom keybinding", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+alt+r",
          command: "script.run-tests.run",
          replace: { key: "mod+r", command: "script.run-tests.run" },
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [
        { key: "mod+shift+r", command: "script.run-tests.run" },
        { key: "mod+alt+r", command: "script.run-tests.run" },
      ]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("replacing with a rule that already exists elsewhere does not duplicate it", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+alt+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+alt+r",
          command: "script.run-tests.run",
          replace: { key: "mod+r", command: "script.run-tests.run" },
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+alt+r", command: "script.run-tests.run" }]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("removes only the targeted custom keybinding", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.removeKeybindingRule({
          key: "mod+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+shift+r", command: "script.run-tests.run" }]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("keeps entries it cannot decode when editing other keybindings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const futureCommand = { key: "mod+shift+k", command: "command.from-a-newer-build" };
      const badShortcut = { key: "mod+shift+d+o", command: "terminal.new" };
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([
          { key: "mod+r", command: "script.run-tests.run" },
          futureCommand,
          badShortcut,
        ]),
      );
      const keybindings = yield* Keybindings.Keybindings;
      const persisted = Effect.map(fs.readFileString(keybindingsConfigPath), JSON.parse);

      const saved = yield* keybindings.upsertKeybindingRule({
        key: "mod+shift+r",
        command: "script.run-tests.run",
      });
      assert.equal(saved.issues.length, 2);
      assert.deepEqual(yield* persisted, [
        { key: "mod+r", command: "script.run-tests.run" },
        futureCommand,
        badShortcut,
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);

      const removed = yield* keybindings.removeKeybindingRule({
        key: "mod+r",
        command: "script.run-tests.run",
      });
      assert.deepEqual(yield* persisted, [
        futureCommand,
        badShortcut,
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      const { issues } = yield* keybindings.loadConfigState;
      assert.deepEqual(removed.issues, issues);
      assert.deepEqual(
        issues.map((issue) => issue.kind === "keybindings.invalid-entry" && issue.index),
        [0, 1],
      );
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("removes a hand-written keybinding targeted by its settings spelling", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        {
          key: "Shift+Cmd+R",
          command: "script.run-tests.run",
          when: "terminalFocus&&!previewFocus",
        },
        { key: "mod+shift+r", command: "script.run-tests.run" },
        { key: "x\u0000true", command: "script.run-tests.run" },
        { key: "x", command: "script.run-tests.run", when: "true" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.removeKeybindingRule({
          key: "meta+shift+r",
          command: "script.run-tests.run",
          when: "terminalFocus && !previewFocus",
        });
        yield* keybindings.removeKeybindingRule({
          key: "x",
          command: "script.run-tests.run",
          when: "true",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(persisted, [
        { key: "mod+shift+r", command: "script.run-tests.run" },
        { key: "x\u0000true", command: "script.run-tests.run" },
      ]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("replaces a hand-written keybinding targeted by its settings spelling", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "escape", command: "script.run-tests.run", when: "a && b && c" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+alt+r",
          command: "script.run-tests.run",
          replace: { key: "esc", command: "script.run-tests.run", when: "(a && b) && c" },
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(persisted, [{ key: "mod+alt+r", command: "script.run-tests.run" }]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("refuses to overwrite malformed keybindings config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const result = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(result, "expected JSON array");

      const persistedRaw = yield* fs.readFileString(keybindingsConfigPath);
      assert.equal(persistedRaw, "{ not-json");
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("retries a failed config read instead of keeping the failure", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fileSystem.makeDirectory(keybindingsConfigPath, { recursive: true });

      const keybindings = yield* Keybindings.Keybindings;
      const failed = yield* toDetailResult(keybindings.loadConfigState);
      assertFailure(failed, "failed to read keybindings config");

      yield* fileSystem.remove(keybindingsConfigPath, { recursive: true });
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const configState = yield* keybindings.loadConfigState;
      assert.deepEqual(configState.issues, []);
      assert.isTrue(configState.keybindings.some((entry) => entry.command === "terminal.toggle"));
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("serializes concurrent upserts to avoid lost updates", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, []);

      const commands = Array.from(
        { length: 20 },
        (_, index): KeybindingCommand => `script.concurrent-${index}.run`,
      );
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* Effect.forEach(
          commands,
          (command, index) =>
            keybindings.upsertKeybindingRule({
              key: `mod+${String.fromCharCode(97 + index)}`,
              command,
            }),
          { concurrency: "unbounded", discard: true },
        );
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedCommands = new Set(persisted.map((entry) => entry.command));
      for (const command of commands) {
        assert.isTrue(persistedCommands.has(command), `expected persisted command ${command}`);
      }
    }).pipe(Effect.provide(layerKeybindings())),
  );
});

// The keybindings.json of a server that ran builds from before the JetBrains keys, as those
// builds wrote it: every default of the time, in the order their backfills left them.
const EXISTING_INSTALL_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+shift+d", command: "composer.dictation", when: "!terminalFocus" },
  { key: "mod+b", command: "sidebar.toggle" },
  { key: "f6", command: "workspace.focusNext" },
  { key: "shift+f6", command: "workspace.focusPrevious" },
  { key: "mod+f6", command: "workspace.focusNext" },
  { key: "mod+shift+f6", command: "workspace.focusPrevious" },
  { key: "mod+[", command: "navigation.back", when: "!terminalFocus" },
  { key: "mod+]", command: "navigation.forward", when: "!terminalFocus" },
  { key: "mod+j", command: "terminal.toggle" },
  { key: "mod+alt+b", command: "rightPanel.toggle" },
  { key: "mod+shift+b", command: "threadPanel.toggle", when: "!terminalFocus" },
  { key: "mod+t", command: "rightPanel.new", when: "rightPanelOpen && !terminalFocus" },
  { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
  { key: "mod+shift+d", command: "terminal.splitVertical", when: "terminalFocus" },
  { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
  { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
  { key: "mod+w", command: "rightPanel.close", when: "!terminalFocus" },
  { key: "mod+shift+t", command: "view.reopenClosed" },
  { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
  { key: "mod+shift+j", command: "preview.toggle" },
  { key: "mod+r", command: "preview.refresh", when: "previewFocus" },
  { key: "mod+l", command: "preview.focusUrl", when: "previewFocus" },
  { key: "mod+=", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod++", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod+-", command: "preview.zoomOut", when: "previewFocus" },
  { key: "mod+0", command: "preview.resetZoom", when: "previewFocus" },
  { key: "mod+k", command: "commandPalette.toggle", when: "!terminalFocus" },
  { key: "mod+p", command: "filePicker.toggle", when: "!terminalFocus" },
  { key: "mod+shift+f", command: "projectSearch.toggle", when: "!terminalFocus" },
  { key: "mod+u", command: "usage.open", when: "!terminalFocus" },
  { key: "mod+alt+a", command: "theme.select", when: "!terminalFocus" },
  { key: "mod+alt+shift+a", command: "appearance.cycle", when: "!terminalFocus" },
  { key: "mod+alt+shift+t", command: "themeEditor.toggle" },
  { key: "mod+s", command: "composer.stash", when: "!terminalFocus" },
  { key: "mod+shift+enter", command: "thread.steerQueuedMessage", when: "!terminalFocus" },
  { key: "alt+arrowup", command: "thread.editQueuedMessage", when: "composerFocus" },
  { key: "mod+enter", command: "composer.sendAlternate", when: "composerFocus && turnRunning" },
  {
    key: "mod+enter",
    command: "composer.sendBackground",
    when: "composerFocus && draftThreadRoute",
  },
  {
    key: "mod+alt+enter",
    command: "composer.sendBackground",
    when: "composerFocus && draftThreadRoute",
  },
  {
    key: "mod+alt+enter",
    command: "composer.sendAndNewThread",
    when: "composerFocus && !draftThreadRoute",
  },
  { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+n", command: "chat.newLocal", when: "!terminalFocus" },
  { key: "mod+alt+n", command: "chat.newWithoutProject", when: "!terminalFocus" },
  { key: "mod+f", command: "chat.find", when: "!terminalFocus && !previewFocus" },
  { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
  { key: "mod+shift+h", command: "composer.host", when: "!terminalFocus" },
  { key: "mod+shift+e", command: "composer.effort", when: "!terminalFocus" },
  { key: "mod+shift+a", command: "composer.mode", when: "!terminalFocus" },
  { key: "mod+shift+x", command: "composer.workspace", when: "!terminalFocus" },
  { key: "mod+shift+g", command: "composer.branch", when: "!terminalFocus" },
  { key: "mod+shift+l", command: "composer.previousWorktree", when: "!terminalFocus" },
  { key: "mod+shift+k", command: "pullRequest.copyNumber", when: "!terminalFocus" },
  { key: "mod+shift+arrowup", command: "modelPicker.previousProvider", when: "modelPickerOpen" },
  { key: "mod+shift+arrowdown", command: "modelPicker.nextProvider", when: "modelPickerOpen" },
  { key: "mod+o", command: "editor.openFavorite" },
  { key: "mod+shift+[", command: "thread.previous" },
  { key: "mod+shift+]", command: "thread.next" },
  { key: "mod+shift+c", command: "thread.copyReference", when: "!terminalFocus" },
  { key: "mod+shift+s", command: "thread.settle", when: "!terminalFocus" },
  { key: "mod+shift+p", command: "thread.pin", when: "!terminalFocus" },
  { key: "mod+z", command: "thread.undo", when: "!terminalFocus && !editableFocus" },
  { key: "mod+1", command: "thread.jump.1", when: "!modelPickerOpen && isDesktop" },
  { key: "mod+2", command: "thread.jump.2", when: "!modelPickerOpen && isDesktop" },
  { key: "mod+3", command: "thread.jump.3", when: "!modelPickerOpen && isDesktop" },
  { key: "mod+4", command: "thread.jump.4", when: "!modelPickerOpen && isDesktop" },
  { key: "mod+5", command: "thread.jump.5", when: "!modelPickerOpen && isDesktop" },
  { key: "mod+6", command: "thread.jump.6", when: "!modelPickerOpen && isDesktop" },
  { key: "mod+7", command: "thread.jump.7", when: "!modelPickerOpen && isDesktop" },
  { key: "mod+8", command: "thread.jump.8", when: "!modelPickerOpen && isDesktop" },
  { key: "mod+9", command: "thread.jump.9", when: "!modelPickerOpen && isDesktop" },
  { key: "mod+1", command: "modelPicker.jump.1", when: "modelPickerOpen && isDesktop" },
  { key: "mod+2", command: "modelPicker.jump.2", when: "modelPickerOpen && isDesktop" },
  { key: "mod+3", command: "modelPicker.jump.3", when: "modelPickerOpen && isDesktop" },
  { key: "mod+4", command: "modelPicker.jump.4", when: "modelPickerOpen && isDesktop" },
  { key: "mod+5", command: "modelPicker.jump.5", when: "modelPickerOpen && isDesktop" },
  { key: "mod+6", command: "modelPicker.jump.6", when: "modelPickerOpen && isDesktop" },
  { key: "mod+7", command: "modelPicker.jump.7", when: "modelPickerOpen && isDesktop" },
  { key: "mod+8", command: "modelPicker.jump.8", when: "modelPickerOpen && isDesktop" },
  { key: "mod+9", command: "modelPicker.jump.9", when: "modelPickerOpen && isDesktop" },
  { key: "c", command: "usage.cost", when: "usagePageOpen" },
  { key: "t", command: "usage.tokens", when: "usagePageOpen" },
  { key: "l", command: "usage.limits", when: "usagePageOpen" },
  { key: "mod+shift+1", command: "usage.period.day", when: "usagePageOpen" },
  { key: "mod+shift+2", command: "usage.period.week", when: "usagePageOpen" },
  { key: "mod+shift+3", command: "usage.period.month", when: "usagePageOpen" },
  { key: "mod+shift+4", command: "usage.period.quarter", when: "usagePageOpen" },
];
