# Keybindings

Customize shortcuts in **Settings → Keybindings** on web and desktop. That page
also lists the command IDs and defaults available in your version.

## Quick reference

On a thread, hold Command on macOS or Ctrl on Windows and Linux for a moment to list the
shortcuts that work where the keyboard is: the composer, a terminal, code, a diff, or the
Project pane. Shortcuts on exactly the keys you hold stand out; add Shift or Alt to see theirs.
Any other key, a click, or moving the pointer hides the list until you hold the key again. It
does not open while the pointer rests on code, where the held key starts a `mod+click`, or while
the command palette is open. Turn it off with **Show shortcuts while Cmd is held** (**Ctrl** on
Windows and Linux) in **Settings → Keybindings**.

## Composer controls

`mod+shift+d` starts dictation in the focused editor, or the composer, and finishes it on the next press;
`Esc` discards the recording. Change the chord under **Composer: Start or Finish
Dictation**, and the hold or toggle behavior in **Settings → Voice**. See
[Voice input](./voice-input.md).

In **Settings → Chat → Send shortcut**, choose whether Enter sends, requires
`mod+Enter` for multiline prompts, or always requires `mod+Enter`. `Shift+Enter`
inserts a new line. This applies to the web and desktop composer at desktop widths.

**Follow-up behavior** chooses Queue or Steer while the agent runs. Use
`mod+Enter` to do the opposite for one message, even when the send shortcut
requires a modifier. `mod+Alt+Enter` sends, keeps that thread running in the
background, and opens a fresh new-thread composer. In a new thread, `mod+Enter`
does the same. Change these shortcuts in **Settings → Keybindings** under
**Composer: Opposite Queue or Steer Action**, **Composer: Start in Background**,
or **Composer: Send and Start New Thread**. These bindings take priority over the
send shortcut. Click the send button to use the configured follow-up behavior.

When a thread has queued messages, `mod+Shift+Enter` sends the first one as a steer
while a turn is running, or as a new turn when the thread is stopped. Change it under
**Queue: Send First Queued Message** in Keybindings.

Use `mod+shift+m` to choose a model and `mod+shift+h` to choose a host.
To step a new thread to the next machine instead of opening the menu, bind
**Composer: Cycle Host** in Keybindings. It has no default shortcut.
Use `mod+shift+e` for effort, `mod+shift+a` for permissions, `mod+shift+x` for the
workspace, and `mod+shift+g` for the Git branch. The workspace menu includes the
current checkout, a new worktree, and the previous worktree when available.
Use `mod+shift+l` to reuse the previous worktree directly.

To change effort one step without opening the picker, bind
**Composer: Increase Effort** and **Composer: Decrease Effort** in Keybindings.
Both are unbound by default. Increase wraps from the highest level to the
lowest, and decrease wraps from the lowest level to the highest.

In the model picker, press Left in an empty search field or Shift+Tab to reach
the provider list. Use Up/Down to move and Enter to choose. Right returns to
model search. Right at the end of the search moves to the highlighted model's effort
levels, and Left comes back. Choosing a model keeps the picker open on its effort. `mod+shift+up` and `mod+shift+down` switch providers directly and clear the
search. These provider shortcuts can also be changed in Settings.

These shortcuts run inside the focused web or desktop client. `mod` uses Command
on macOS and Ctrl on Windows and Linux, including GNOME, KDE Plasma, Niri, and
Hyprland. If a custom desktop shortcut takes the same keys, choose another binding
in Settings.

## Copy pull request references

With a PR open in the right panel or on the Pull requests page, use `mod+shift+c`
to copy its URL and `mod+shift+k` to copy its number with a `#` prefix.
Both shortcuts can be changed in Settings. Search for “Copy Link or Thread”
or “Copy Number”. They copy the selected PR and leave terminal input alone.
Without a PR, `mod+shift+c` copies the thread itself, which pastes into a
composer as a thread chip.

## Find in a diff

Click into a diff in the Diff panel or a pull request's Code tab, then press
`mod+f` to search every file in it, including folded files and unchanged lines
hidden between changes. Enter and `Shift+Enter` move between matches, and a
match in a folded file opens it. Escape closes the search. This shortcut is not
configurable. A very large uncommitted diff loads its files as you scroll, and
find only searches the files loaded so far.

The side-by-side layout finds in one side of one file instead: the side the
keyboard is in. That one is the `diff.find` command, which you can rebind.

## Code, diffs, and the Project pane

Code navigation, the side-by-side diff, and the Project pane use the shortcuts of JetBrains
IDEs. Each runs only where it applies, and the key keeps its other command everywhere else:
`mod+b` goes to a declaration while the keyboard is in code or a turn's side-by-side diff, and
toggles the sidebar anywhere else. The features are described in
[Code and the Project pane](./code.md) and [Side-by-side diff](./source-control.md#side-by-side-diff).

| Shortcut                                     | Command                                  | Runs while the keyboard is in        |
| -------------------------------------------- | ---------------------------------------- | ------------------------------------ |
| `mod+b`                                      | Go to Declaration or Usages              | code or a turn's side-by-side diff   |
| `mod+shift+b`                                | Go to Type Declaration                   | code                                 |
| `mod+alt+b`                                  | Go to Implementation                     | code                                 |
| `alt+f7`, `mod+alt+f7`                       | Find Usages                              | code                                 |
| `mod+shift+f7`                               | Highlight Usages in File                 | code                                 |
| `f1`                                         | Quick Documentation                      | code                                 |
| `alt+space`                                  | Quick Definition                         | code                                 |
| `mod+l`                                      | Go to Line                               | code                                 |
| `mod+o`                                      | Go to Class                              | code or the Project pane             |
| `mod+alt+o`                                  | Go to Symbol                             | anything but a terminal              |
| `mod+shift+o`                                | Open the file picker                     | code or the Project pane             |
| `mod+e`                                      | Recent Files                             | anything but a terminal              |
| `mod+f12`                                    | File Structure                           | code                                 |
| `ctrl+shift+arrowdown`, `ctrl+shift+arrowup` | Next Method, Previous Method             | code                                 |
| `f7`, `shift+f7`                             | Next Change, Previous Change             | a side-by-side diff                  |
| `f4`, `mod+arrowdown`                        | Jump to Source                           | a turn's side-by-side diff           |
| `mod+f`                                      | Find in that side of the diff            | a side-by-side diff                  |
| `mod+1`                                      | Show the Project pane, or return to code | code or the Project pane, on desktop |
| `alt+f1`                                     | Select Opened File in the Project pane   | code                                 |
| `mod+alt+arrowleft`, `mod+alt+arrowright`    | Back, Forward                            | anything but a terminal, on desktop  |

A comment box or a find field inside code or a diff is a text field, so these shortcuts leave
its typing alone. Where a feature does not work, such as code navigation in a thread on a
machine whose server lacks it, its keys keep their other command. In a browser tab, `mod+1`
and `mod+alt+arrowleft` / `mod+alt+arrowright` stay with the browser. To keep one of these
keys for its other command everywhere, give the command in this table another shortcut in
**Settings → Keybindings**.

Shortcuts come from your primary environment. If its server is older than this app,
`mod+shift+o`, `mod+alt+arrowleft` / `mod+alt+arrowright`, and `mod+b` in a side-by-side diff
are missing until you update it; the rest of the table works.

## iPad

With a hardware keyboard, use `Cmd+1` through `Cmd+9` to open the first nine
displayed threads. The shortcuts follow the current list filters and order.
`Cmd+K` opens the command palette to search commands, projects, and threads.
Use the arrow keys and Return to choose a result, or `Cmd+1` through `Cmd+9` to
choose directly. Escape or `Cmd+K` closes the palette. Start a search with `>`
to show only actions.

In a new thread, `Cmd+Shift+H` moves the draft to the next machine.

In the composer, Return sends and `Shift+Return` inserts a new line. While a
turn is running, `Cmd+Return` sends with the other follow-up action. To make
Return insert a new line instead, change the Return key behavior in Settings →
Keyboard; `Cmd+Return` then sends.

## Android

With a hardware keyboard, the composer handles Return as on iPad, with `Ctrl` in
place of `Cmd`. The on-screen keyboard's Return always inserts a new line.

## Edit the configuration file

Keybindings live on the environment's machine, in
`~/.t3/userdata/keybindings.json` by default. You can edit this file directly.
It is a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

T3 Code creates the file with its defaults and adds new defaults on later startups.
New defaults do not replace commands you customized, and your rules stay where they are.
A new default that shares a shortcut with older defaults goes right after them, and before
the first rule of yours that comes after one of them. By [rule order](#precedence) it refines
the older defaults, and your rule still wins.
Invalid rules are ignored, and T3 Code adds nothing to the file while it has one; if the
file cannot be parsed, T3 Code uses defaults. T3 Code rewrites the file when it adds defaults
or saves a change from Settings, so comments in it are not kept.

## Rule shape

Each rule requires a `key` shortcut and a `command` ID. An optional `when`
expression restricts when it runs.

Project scripts use `script.{id}.run`, such as `script.test.run`.

## Key syntax

Join modifiers and a key with `+`, such as `mod+shift+d` or `ctrl+l`.
`mod` means Command on macOS and Control elsewhere. Other modifiers are
`cmd` / `meta`, `ctrl` / `control`, `alt` / `option`, and `shift`.

## When conditions

Available context keys are `terminalFocus`, `terminalOpen`, `previewFocus`,
`previewOpen`, `rightPanelOpen`, `modelPickerOpen`, `usagePageOpen`, `composerFocus`,
`draftThreadRoute`, `turnRunning`, `editableFocus`, `codeFocus`, `diffFocus`,
`projectTreeFocus`, `codeNavigation`, `codeSymbols`, `projectPane`, `isWeb`, and `isDesktop`.
`rightPanelOpen` applies only to `rightPanel.new` and is true while the right panel is
open; the default `mod+t` uses it to open the panel's new-tab menu.
`draftThreadRoute` is true on a draft thread, including a restored draft, until it is first sent.
`editableFocus` is true while a text field, the composer, or another editor has
the keyboard. `codeFocus` is true while the keyboard is in code, such as an open file.
`diffFocus` is true in the side-by-side diff. `projectTreeFocus` is true in the Project pane,
including its search field. A text field inside code or a diff, such as a comment box, turns
`codeFocus` and `diffFocus` off. `codeNavigation`, `codeSymbols` and `projectPane` are true
where code navigation, symbol search and the Project pane work: code navigation, for one,
needs the thread's machine to run a server that has it. `isWeb` is true in a browser tab. `isDesktop` is true in
the desktop app. Unknown keys evaluate to `false`.

`mod+1` through `mod+9` jump to the first nine threads, and to models while the
model picker is open. The thread jumps do not run while the model picker is open.
Those defaults use `isDesktop` so they do not steal the
browser's tab-switch shortcuts. Remove that condition in Settings if you want
the same jumps in a browser.

Combine keys with `!` for not, `&&` for and, `||` for or, and parentheses:

```json
{ "key": "mod+j", "command": "terminal.toggle", "when": "terminalOpen && !terminalFocus" }
```

## Find in the current thread

`chat.find` searches conversation messages and proposed plans in the active thread. Entering a
query searches the entire thread, including older messages. Thread search requires server support;
update an older server to enable it. Select **Retry** if a search fails. It defaults to
`mod+f` outside terminals and previews. Press **Enter** or **Shift+Enter** to move between matches,
and **Escape** to close find.

## Precedence

The last rule whose key and condition both match wins, even if it belongs to a
different command. Put a more specific rule after a general one when they share
a shortcut.

## Commands with special behavior

`thread.stop` interrupts the running turn in the focused thread. It has no default
shortcut; assign one in **Settings → Keybindings**.

`thread.undo` (`mod+z` by default) reverses the actions shown in the notice at the
bottom of the sidebar, such as unpin, settle, snooze, archive, or discarding a
draft. Consecutive
actions of the same kind undo together. The notice remains available for five
seconds after the latest action. Right after an action, the shortcut works even
in a text field such as the composer. Once you type or press another key, the
field gets its own undo back. Terminals always keep their native shortcut.

`navigation.back` (`mod+[` by default) and `navigation.forward` (`mod+]`) move
through the pages you have visited, like a browser's back and forward buttons.

`chat.new` may ask you to choose a project when there is more than one.
`chat.newLocal` skips that chooser. Both use your
[new-thread defaults](./thread-sidebar.md#start-a-thread). `chat.newWithoutProject`
(`mod+alt+n`) starts a thread [without a project](./thread-sidebar.md#start-without-a-project).

## Reserved shortcuts

In the desktop app, `mod+w` closes the focused terminal or the active right-panel
tab. When nothing remains to close, it does nothing; it never closes the window. In a browser, `mod+w`
closes the browser tab; rebind `rightPanel.close` and `terminal.close` to an available
shortcut such as `alt+w`.

`mod+shift+t` reopens the last closed tab across the app, including files,
diffs, pull requests, browsers, and devices, in the order you closed them.
A browser opens in a fresh session without its old page history. Incognito tabs
can reopen until you reload or quit the app. This shortcut does not undo deleted work.
Browsers also use it to reopen browser tabs; choose another binding in Settings
if the browser takes it first.

Many defaults include `!terminalFocus` so they do not intercept terminal input.
Keep that condition when remapping them if you want the same behavior.

## Desktop quit shortcut

Use `Cmd+Q` on macOS or `Ctrl+Q` on Windows and Linux. In the default **Hold** mode,
hold for 1.2 seconds or press twice within 500 milliseconds. Holding requires
keyboard repeat; if repeat is disabled, use two presses or the application menu.

Change **Settings → General → Confirmations → Quit shortcut** to **Direct** for a
single press or **Double press** for two presses only. Choosing **Quit** from the
application menu always quits immediately.
