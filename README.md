# pi-qol

A quality of life extension for [Pi](https://pi.dev). It adds response statistics, thread deletion, ephemeral chats, and HTML exports from `pi-better-export`.

## Install

Requires Node.js 22.19 or later and Pi 1.3.x.

```sh
pi install git:github.com/thgilciffart/pi-qol
```

Run `/reload` in an open Pi session. Remove standalone installations of `pi-ephemeral` and `pi-better-export` to avoid command conflicts.

## Install from a checkout

Development checks also require Bun.

1. Install dependencies in this directory.

   ```sh
   npm ci
   ```

2. Remove the standalone plugins if you installed them through Pi.

   ```sh
   pi remove npm:@thgilciffart/pi-ephemeral
   pi remove npm:pi-better-export
   ```

   If you loaded either plugin through a local path or a settings file, remove that entry instead.

3. Install this directory as a Pi package.

   ```sh
   pi install .
   ```

4. Run `/reload` in an open Pi session.

To try the extension without installing it, run `pi -e ./index.ts` from this directory.

## Read response statistics

Send a prompt. Each final assistant reply has a row with separate input and output token counts, tokens per second, and TTFT. Tool-call messages have no statistics row. Statistics appear only in the transcript.

See [statistics and command reference](docs/reference.md) for measurement definitions and limits.

## Delete threads

Deletion permanently removes session files. There is no undo. Close a thread in other Pi processes before deleting its file.

To delete the current thread, run `/delete` and accept the confirmation. Pi starts a new chat before the extension removes the old file. Cancelling the session change preserves the old file.

To delete several threads:

1. Run `/delete-threads` to open the thread picker.
2. Type to search. Press Tab to switch between the current project and all projects.
3. Press Space or Enter to select a thread and move to the next row. Press Ctrl+A to select all matching threads.
4. Press Ctrl+D to review the deletion confirmation.
5. Press Enter to confirm, or N to return to the list.

Press Escape to exit without deleting any unconfirmed selection. If no threads are selected, Ctrl+D asks to delete the highlighted thread. The current thread is excluded from the picker.

The picker stays open after deletion. Use `/delete-threads search text` to start with a search.

## Start an ephemeral chat

Run `/ephemeral`, then accept the confirmation. The new chat keeps its history in memory and shows an ephemeral badge in the footer. The previous saved chat remains on disk.

To send an initial prompt into the new chat:

```text
/ephemeral explain this repository
```

Ephemeral mode controls Pi's session file. Exported HTML and files that tools create still write to disk.

## Export a chat

Run `/better-export` to save the current session as HTML. Pi asks before replacing a file and offers to open the result in your browser.

```text
/better-export
/better-export "exports/My session.html"
/better-export --share --redact-text "Acme Internal" sharing.html
```

The export includes the current theme, offline LaTeX, equation copying, and a **Print / PDF** button. The default export retains the session tree, search, filters, and code highlighting.

Use `--share` to export the active conversation with a redaction preview. Review the HTML before sharing it. Detection uses text patterns and does not scan images.

Pi handles its built-in `/export` before extension commands. Use `/better-export` for this exporter.

## Check changes

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

The tests cover response statistics, deletion, ephemeral persistence, HTML rendering, redaction, and extension loading. They use temporary session files and do not delete your saved chats.

See [Publish to npm](docs/publishing.md) for release commands and Pi package discovery.

[MIT license](LICENSE). Embedded KaTeX assets retain their upstream license notices.
