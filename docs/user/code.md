# Code and the Project pane

On web and desktop, T3 Code browses and navigates a project's code the way JetBrains IDEs do.
Files open in the right panel's file viewer. In the shortcuts below, `mod` is Command on macOS
and Ctrl on Windows and Linux. The full list, and where each key works, is in
[Keyboard shortcuts](./keybindings.md#code-diffs-and-the-project-pane).

## Project pane

Switch the left sidebar from **Threads** to **Project** to browse the current thread's
workspace: its worktree, or the project folder. Choose a file to open it in the right panel. With
a row focused, type to search the tree. The thread list keeps its place while you are away.

The tree follows the file open in the right panel. **Select Opened File** (`alt+f1` in code)
reveals that file and moves the keyboard to the tree. On desktop, `mod+1` moves between code and
the tree, opening a collapsed sidebar for the trip and closing it again when you return.

### Git colors

Files are colored by how they changed in the working tree: added, modified, renamed, untracked,
or ignored. A folder that holds changes is marked too. A deleted file has no row. Under
[Material Ocean](./appearance.md#material-ocean) the colors are JetBrains Material's. With
**Blue & orange** in **Settings → Diffs → Diff colors**, added and untracked files use those
colors instead.

### External Libraries

**External Libraries**, below the tree, lists the library folders the language servers read,
such as a Python virtualenv's `site-packages`, the standard library, typeshed, and `node_modules`.
Folders list as you expand them, and their files open read-only. The section is hidden when there
are none.

## Code navigation

Python and TypeScript or JavaScript files in the file viewer can be navigated. The environment's
server must support code intelligence; on an older server, update it. TypeScript works out of the
box. For Python, choose the **ty** chip at the top of the file and **Install ty**.

`mod+click` a name, or put the caret on it and press `mod+b`, to go to its declaration. Holding
`mod` underlines what you can click. When there are several targets, choose one. On the
declaration itself, you get its usages instead. A declaration in an installed package or the
standard library opens read-only.

`alt+f7` lists usages grouped by file, with a filter. Enter opens one; `mod+Enter` opens it and
keeps the list. In a file with no language server, `alt+f7` searches the project's text instead.
`f1` shows documentation, `alt+space` shows the definition in place, and `mod+l` goes to a line.
`mod+[` and `mod+]`, or `mod+alt+arrowleft` and `mod+alt+arrowright` on desktop, go back and
forward along your jumps.

### Python environment

The **ty** chip shows the interpreter found from the project's files: a `.venv` or `venv` folder,
or one named in `pyrightconfig.json` or `pyproject.toml`. A worktree without one uses the main
checkout's. To use another, enter a virtualenv or an
interpreter path in the chip's **Python environment** field and choose **Apply**. It wins over the
one found, and the Python server restarts to use it. A connection that can't restart servers saves
it for the server's next start. A relative path starts at the workspace. Clear the
field and apply to go back to finding one. Each workspace, including each worktree, keeps its own
setting.

To stop language servers in an environment, set `"codeIntel": { "enabled": false }` in its
server's `settings.json`. The chip then reads **off** and offers **Turn on**.

## Symbols and pickers

- `mod+o` searches the workspace for classes, and `mod+alt+o` for any symbol. Project symbols
  come before library ones. Both are also **Go to class** and **Go to symbol** in the command
  palette. The first search in a large TypeScript project can take several seconds.
- `mod+f12` in code lists the file's structure. Type to filter, and Enter to jump.
- `mod+e` lists files recently opened in this thread. Press `mod+e` again to open the highlighted
  one, so `mod+e` twice returns to the previous file.
- `ctrl+shift+arrowdown` and `ctrl+shift+arrowup` move to the next or previous method.

In each picker, Enter opens the highlighted result. Tap Shift twice outside a text field, or in
code, to open the command palette. Turn that off with **Double Shift opens the command palette**
in **Settings → Keybindings**. It is off while SnapShot captures with both Shift keys.

## Semantic highlighting

Under [Material Ocean](./appearance.md#material-ocean), the file viewer colors Python and
TypeScript by what each name is, such as a parameter, a property, a decorator, or a call, on top
of the usual syntax colors. These colors come from the language server, so they arrive a moment
after the file opens or changes. Opening a Python or TypeScript file under this theme starts its
language server. The theme's italic and bold styles show as color only. Other themes keep syntax
colors alone.
