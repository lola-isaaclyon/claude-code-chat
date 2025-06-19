# TODO: Command Palette Buttons for Preset Commands

## Goal
Implement a command palette with clickable buttons in the chat UI. The palette must provide:

1. A **Compact** button that automatically sends the `/compact` command to Claude Code.
2. Three configurable buttons that invoke custom `/slash` commands.
3. Three configurable buttons that insert predefined `@` file references.

## Proposed Approach

### 1. Extension Configuration
- Add new settings in `package.json` under `contributes.configuration`:
  - `claudeCodeChat.slashCommands`: array of three strings for custom `/` commands. Default could be `['/refactor', '/explain', '/test']`.
  - `claudeCodeChat.fileShortcuts`: array of three file paths or glob patterns for `@` references. These should be workspace-relative paths.
- Provide descriptive titles and defaults so users can change them from VS Code settings UI.

### 2. Send Config to Webview
- When creating the webview in `ClaudeChatProvider.show()`, read the above configuration values using `vscode.workspace.getConfiguration()`.
- After the `ready` message, post another message of type `config` containing the slash commands and file shortcuts. Example:
  ```ts
  this._panel?.webview.postMessage({
      type: 'config',
      data: {
          slashCommands: config.get('slashCommands'),
          fileShortcuts: config.get('fileShortcuts')
      }
  });
  ```

### 3. UI Updates
- In `src/ui.ts` create a new section above the text input called **commandPalette**.
- Render seven buttons:
  - **Compact** – hard‑coded label. On click, set the textarea value to `/compact` and call `sendMessage()`.
  - Three **slash** buttons – labels from `config.slashCommands`. Each click should insert the corresponding command (e.g. `/mycommand`) into the input and immediately send.
  - Three **file** buttons – labels derived from the filename portion of each shortcut. On click, insert `@<file>` into the input and immediately send.
- Use existing styling classes (`btn` or new `.command-btn`) so the palette matches the rest of the UI.
- Hide a button if its config value is empty.

### 4. Message Handling
- Add a handler in the webview script for the new `config` message. Store the data and populate the command palette when received.
- Ensure buttons stay in sync when configuration changes. (Optional future work: listen for `vscode.workspace.onDidChangeConfiguration` and resend config.)

### 5. Testing
- Update unit tests to verify that configuration is read and sent to the webview.
- Add a UI test (if possible) or manual instructions to confirm buttons send the expected messages.

## Potential Challenges
- Keeping the UI responsive when configuration changes while the webview is open.
- Validating file paths for the `@` buttons across different operating systems.

## Estimated Effort
- **Configuration & message plumbing**: 2–3 hours.
- **HTML/CSS/JS changes**: 3–4 hours.
- **Testing and polish**: 1–2 hours.

