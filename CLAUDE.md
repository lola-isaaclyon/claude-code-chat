# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Chat is a VS Code extension that provides a beautiful graphical interface for interacting with Claude Code. It eliminates the need for terminal commands by offering a chat-based UI directly integrated into the VS Code editor. The extension was built using Claude Code itself as a proof of concept.

## Architecture

### Core Components

- **`src/extension.ts`** - Main extension entry point containing:
  - `ClaudeChatProvider` - Manages webview panel, Claude process communication, and conversation history
  - `ClaudeChatViewProvider` - Tree data provider for the activity bar sidebar
  - Session management with automatic backup/restore functionality via Git
  - Real-time streaming JSON communication with Claude Code CLI

- **`src/ui.ts`** - Contains the complete HTML/CSS/JavaScript for the webview chat interface
  - Self-contained single-file UI with VS Code theming integration
  - Handles message rendering, file references, and command palette

### Key Features Architecture

1. **Session Management**: Uses Claude Code CLI's `--resume` flag with session IDs to maintain conversation continuity
2. **Backup System**: Creates Git commits before each Claude interaction for instant rollback capability
3. **Conversation Persistence**: Saves all conversations as JSON files with indexed metadata
4. **Streaming Communication**: Processes real-time JSON streams from Claude Code CLI for responsive UI
5. **File Integration**: Workspace file search and reference system with `@` syntax

## Development Commands

```bash
# Compile TypeScript
npm run compile

# Watch mode for development
npm run watch

# Run linter
npm run lint

# Run tests
npm run test

# Prepare for publishing
npm run vscode:prepublish
```

## VS Code Extension Development

- **Debug**: Press `F5` or use "Run and Debug" panel to launch extension host
- **Package**: Generated extension loads in `out/` directory after compilation
- **Main entry**: Extension activates on `claude-code-chat.openChat` command
- **Webview**: Single HTML string in `ui.ts` with full chat functionality

## Configuration Schema

The extension supports these configurable settings:
- `claudeCodeChat.slashCommands`: Array of slash commands for palette buttons (default: `["/refactor", "/explain", "/test"]`)
- `claudeCodeChat.fileShortcuts`: Array of file paths for `@` reference buttons (default: common project files)

## Message Flow

1. User input → `ClaudeChatProvider._sendMessageToClaude()`
2. Backup commit created → Git repository in extension storage
3. Claude Code CLI spawned with streaming JSON output
4. Real-time JSON parsing → UI updates via webview messages
5. Conversation automatically saved to JSON file

## Testing Strategy

- Extension tests use VS Code test framework with Mocha
- Manual testing via F5 debug launch
- Test both Claude Code CLI integration and webview functionality
- Verify backup/restore system with actual Git operations

## Dependencies

- **Runtime**: Requires Claude Code CLI installed and authenticated
- **VS Code API**: Uses webview, file system, workspace, commands, and tree view APIs
- **Node.js**: Child process spawning for Claude Code CLI communication
- **Git**: Used for backup system via shell commands

## Command Palette Integration

The extension registers:
- Primary command: `claude-code-chat.openChat` (Ctrl+Shift+C)
- Conversation loader: `claude-code-chat.loadConversation`
- Activity bar integration and context menu entries across VS Code UI