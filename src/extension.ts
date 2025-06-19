import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as util from 'util';
import * as path from 'path';
import html from './ui';

const exec = util.promisify(cp.exec);

export function activate(context: vscode.ExtensionContext) {
	const provider = new ClaudeChatProvider(context.extensionUri, context);

	const disposable = vscode.commands.registerCommand('claude-code-chat.openChat', () => {
		provider.show();
	});

	const loadConversationDisposable = vscode.commands.registerCommand('claude-code-chat.loadConversation', (filename: string) => {
		provider.loadConversation(filename);
	});

	// Register tree data provider for the activity bar view
	const treeProvider = new ClaudeChatViewProvider(context.extensionUri, context, provider);
	vscode.window.registerTreeDataProvider('claude-code-chat.chat', treeProvider);

	// Make tree provider accessible to chat provider for refreshing
	provider.setTreeProvider(treeProvider);


	// Create status bar item
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.text = "Claude";
	statusBarItem.tooltip = "Open Claude Code Chat (Ctrl+Shift+C)";
	statusBarItem.command = 'claude-code-chat.openChat';
	statusBarItem.show();

	context.subscriptions.push(disposable, loadConversationDisposable, statusBarItem);
}

export function deactivate() { }

class ClaudeChatViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
	readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

	constructor(
		private extensionUri: vscode.Uri,
		private context: vscode.ExtensionContext,
		private chatProvider: ClaudeChatProvider
	) { }

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(): vscode.TreeItem[] {
		const items: vscode.TreeItem[] = [];

		// Add "Open Claude Code Chat" item
		const openChatItem = new vscode.TreeItem('Open Claude Code Chat', vscode.TreeItemCollapsibleState.None);
		openChatItem.command = {
			command: 'claude-code-chat.openChat',
			title: 'Open Claude Code Chat'
		};
		openChatItem.iconPath = vscode.Uri.joinPath(this.extensionUri, 'icon.png');
		openChatItem.tooltip = 'Open Claude Code Chat (Ctrl+Shift+C)';
		items.push(openChatItem);

		// Add conversation history items
		const conversationIndex = this.context.workspaceState.get('claude.conversationIndex', []) as any[];

		if (conversationIndex.length > 0) {
			// Add separator
			const separatorItem = new vscode.TreeItem('Recent Conversations', vscode.TreeItemCollapsibleState.None);
			separatorItem.description = '';
			separatorItem.tooltip = 'Click on any conversation to load it';
			items.push(separatorItem);

			// Add conversation items (show only last 5 for cleaner UI)
			conversationIndex.slice(0, 20).forEach((conv, index) => {
				const item = new vscode.TreeItem(
					conv.firstUserMessage.substring(0, 50) + (conv.firstUserMessage.length > 50 ? '...' : ''),
					vscode.TreeItemCollapsibleState.None
				);
				item.description = new Date(conv.startTime).toLocaleDateString();
				item.tooltip = `First: ${conv.firstUserMessage}\nLast: ${conv.lastUserMessage}\nMessages: ${conv.messageCount}, Cost: $${conv.totalCost.toFixed(3)}`;
				item.command = {
					command: 'claude-code-chat.loadConversation',
					title: 'Load Conversation',
					arguments: [conv.filename]
				};
				item.iconPath = new vscode.ThemeIcon('comment-discussion');
				items.push(item);
			});
		}

		return items;
	}
}

class ClaudeChatProvider {
	private _panel: vscode.WebviewPanel | undefined;
	private _disposables: vscode.Disposable[] = [];
	private _totalCost: number = 0;
	private _totalTokensInput: number = 0;
	private _totalTokensOutput: number = 0;
	private _requestCount: number = 0;
	private _currentSessionId: string | undefined;
	private _backupRepoPath: string | undefined;
	private _commits: Array<{ id: string, sha: string, message: string, timestamp: string }> = [];
	private _conversationsPath: string | undefined;
	private _currentConversation: Array<{ timestamp: string, messageType: string, data: any }> = [];
	private _conversationStartTime: string | undefined;
	private _conversationIndex: Array<{
		filename: string,
		sessionId: string,
		startTime: string,
		endTime: string,
		messageCount: number,
		totalCost: number,
		firstUserMessage: string,
		lastUserMessage: string
	}> = [];
	private _treeProvider: ClaudeChatViewProvider | undefined;
	private _currentClaudeProcess: cp.ChildProcess | undefined;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _context: vscode.ExtensionContext
	) {

		// Initialize backup repository and conversations
		this._initializeBackupRepo();
		this._initializeConversations();

		// Load conversation index from workspace state
		this._conversationIndex = this._context.workspaceState.get('claude.conversationIndex', []);

		// Resume session from latest conversation
		const latestConversation = this._getLatestConversation();
		this._currentSessionId = latestConversation?.sessionId;
	}

	public show() {
		const column = vscode.ViewColumn.Two;

		if (this._panel) {
			this._panel.reveal(column);
			return;
		}

		this._panel = vscode.window.createWebviewPanel(
			'claudeChat',
			'Claude Code Chat',
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [this._extensionUri]
			}
		);

		// Set icon for the webview tab using URI path
		const iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.png');
		this._panel.iconPath = iconPath;

		this._panel.webview.html = this._getHtmlForWebview();

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		this._panel.webview.onDidReceiveMessage(
			message => {
				switch (message.type) {
					case 'sendMessage':
						this._sendMessageToClaude(message.text);
						return;
					case 'newSession':
						this._newSession();
						return;
					case 'restoreCommit':
						this._restoreToCommit(message.commitSha);
						return;
					case 'getConversationList':
						this._sendConversationList();
						return;
					case 'getWorkspaceFiles':
						this._sendWorkspaceFiles(message.searchTerm);
						return;
					case 'selectImageFile':
						this._selectImageFile();
						return;
					case 'loadConversation':
						this.loadConversation(message.filename);
						return;
					case 'stopRequest':
						this._stopClaudeProcess();
						return;
				}
			},
			null,
			this._disposables
		);

		// Resume session from latest conversation
		const latestConversation = this._getLatestConversation();
		this._currentSessionId = latestConversation?.sessionId;

		// Load latest conversation history if available
		if (latestConversation) {
			this._loadConversationHistory(latestConversation.filename);
		}

		// Send ready message immediately
		setTimeout(() => {
			// Send current session info if available
			if (this._currentSessionId) {
				this._panel?.webview.postMessage({
					type: 'sessionResumed',
					data: {
						sessionId: this._currentSessionId
					}
				});
			}

			// Send configuration for command palette
			const config = vscode.workspace.getConfiguration('claudeCodeChat');
			this._panel?.webview.postMessage({
				type: 'config',
				data: {
					slashCommands: config.get('slashCommands', ['/refactor', '/explain', '/test']),
					fileShortcuts: config.get('fileShortcuts', ['src/extension.ts', 'src/ui.ts', 'README.md'])
				}
			});

			this._panel?.webview.postMessage({
				type: 'ready',
				data: 'Ready to chat with Claude Code! Type your message below.'
			});
		}, 100);
	}

	private async _sendMessageToClaude(message: string) {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		const cwd = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();

		// Show user input in chat and save to conversation
		this._sendAndSaveMessage({
			type: 'userInput',
			data: message
		});

		// Set processing state
		this._panel?.webview.postMessage({
			type: 'setProcessing',
			data: true
		});

		// Create backup commit before Claude makes changes
		try {
			await this._createBackupCommit(message);
		}
		catch (e) {
			console.log("error", e)
		}

		// Show loading indicator
		this._panel?.webview.postMessage({
			type: 'loading',
			data: 'Claude is thinking...'
		});

		// Call claude with the message via stdin using stream-json format
		console.log('Calling Claude with message via stdin:', message);

		// Build command arguments with session management
		const args = [
			'-p',
			'--output-format', 'stream-json', '--verbose',
			'--dangerously-skip-permissions'
		];

		// Add session resume if we have a current session
		if (this._currentSessionId) {
			args.push('--resume', this._currentSessionId);
			console.log('Resuming session:', this._currentSessionId);
		} else {
			console.log('Starting new session');
		}

		console.log('Claude command args:', args);

		const claudeProcess = cp.spawn('claude', args, {
			cwd: cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: {
				...process.env,
				FORCE_COLOR: '0',
				NO_COLOR: '1'
			}
		});

		// Store process reference for potential termination
		this._currentClaudeProcess = claudeProcess;

		// Send the message to Claude's stdin
		if (claudeProcess.stdin) {
			claudeProcess.stdin.write(message + '\n');
			claudeProcess.stdin.end();
		}

		let rawOutput = '';
		let errorOutput = '';

		if (claudeProcess.stdout) {
			claudeProcess.stdout.on('data', (data) => {
				rawOutput += data.toString();

				// Process JSON stream line by line
				const lines = rawOutput.split('\n');
				rawOutput = lines.pop() || ''; // Keep incomplete line for next chunk

				for (const line of lines) {
					if (line.trim()) {
						try {
							const jsonData = JSON.parse(line.trim());
							this._processJsonStreamData(jsonData);
						} catch (error) {
							console.log('Failed to parse JSON line:', line, error);
						}
					}
				}
			});
		}

		if (claudeProcess.stderr) {
			claudeProcess.stderr.on('data', (data) => {
				errorOutput += data.toString();
			});
		}

		claudeProcess.on('close', (code) => {
			console.log('Claude process closed with code:', code);
			console.log('Claude stderr output:', errorOutput);

			// Clear process reference
			this._currentClaudeProcess = undefined;

			// Clear loading indicator
			this._panel?.webview.postMessage({
				type: 'clearLoading'
			});

			if (code !== 0 && errorOutput.trim()) {
				// Error with output
				this._sendAndSaveMessage({
					type: 'error',
					data: errorOutput.trim()
				});
			}
		});

		claudeProcess.on('error', (error) => {
			console.log('Claude process error:', error.message);
			
			// Clear process reference
			this._currentClaudeProcess = undefined;
			
			this._panel?.webview.postMessage({
				type: 'clearLoading'
			});
			
			// Check if claude command is not installed
			if (error.message.includes('ENOENT') || error.message.includes('command not found')) {
				this._sendAndSaveMessage({
					type: 'error',
					data: 'Install claude code first: https://www.anthropic.com/claude-code'
				});
			} else {
				this._sendAndSaveMessage({
					type: 'error',
					data: `Error running Claude: ${error.message}`
				});
			}
		});
	}

	private _processJsonStreamData(jsonData: any) {
		console.log('Received JSON data:', jsonData);

		switch (jsonData.type) {
			case 'system':
				if (jsonData.subtype === 'init') {
					// System initialization message - session ID will be captured from final result
					console.log('System initialized');
				}
				break;

			case 'assistant':
				if (jsonData.message && jsonData.message.content) {
					// Track token usage in real-time if available
					if (jsonData.message.usage) {
						this._totalTokensInput += jsonData.message.usage.input_tokens || 0;
						this._totalTokensOutput += jsonData.message.usage.output_tokens || 0;

						// Send real-time token update to webview
						this._sendAndSaveMessage({
							type: 'updateTokens',
							data: {
								totalTokensInput: this._totalTokensInput,
								totalTokensOutput: this._totalTokensOutput,
								currentInputTokens: jsonData.message.usage.input_tokens || 0,
								currentOutputTokens: jsonData.message.usage.output_tokens || 0,
								cacheCreationTokens: jsonData.message.usage.cache_creation_input_tokens || 0,
								cacheReadTokens: jsonData.message.usage.cache_read_input_tokens || 0
							}
						});
					}

					// Process each content item in the assistant message
					for (const content of jsonData.message.content) {
						if (content.type === 'text' && content.text.trim()) {
							// Show text content and save to conversation
							this._sendAndSaveMessage({
								type: 'output',
								data: content.text.trim()
							});
						} else if (content.type === 'thinking' && content.thinking.trim()) {
							// Show thinking content and save to conversation
							this._sendAndSaveMessage({
								type: 'thinking',
								data: content.thinking.trim()
							});
						} else if (content.type === 'tool_use') {
							// Show tool execution with better formatting
							const toolInfo = `🔧 Executing: ${content.name}`;
							let toolInput = '';

							if (content.input) {
								// Special formatting for TodoWrite to make it more readable
								if (content.name === 'TodoWrite' && content.input.todos) {
									toolInput = '\nTodo List Update:';
									for (const todo of content.input.todos) {
										const status = todo.status === 'completed' ? '✅' :
											todo.status === 'in_progress' ? '🔄' : '⏳';
										toolInput += `\n${status} ${todo.content} (priority: ${todo.priority})`;
									}
								} else {
									// Send raw input to UI for formatting
									toolInput = '';
								}
							}

							// Show tool use and save to conversation
							this._sendAndSaveMessage({
								type: 'toolUse',
								data: {
									toolInfo: toolInfo,
									toolInput: toolInput,
									rawInput: content.input,
									toolName: content.name
								}
							});
						}
					}
				}
				break;

			case 'user':
				if (jsonData.message && jsonData.message.content) {
					// Process tool results from user messages
					for (const content of jsonData.message.content) {
						if (content.type === 'tool_result') {
							let resultContent = content.content || 'Tool executed successfully';
							const isError = content.is_error || false;

							// Show tool result and save to conversation
							this._sendAndSaveMessage({
								type: 'toolResult',
								data: {
									content: resultContent,
									isError: isError,
									toolUseId: content.tool_use_id
								}
							});
						}
					}
				}
				break;

			case 'result':
				if (jsonData.subtype === 'success') {
					// Check for login errors
					if (jsonData.is_error && jsonData.result && jsonData.result.includes('Invalid API key')) {
						this._handleLoginRequired();
						return;
					}

					// Capture session ID from final result
					if (jsonData.session_id) {
						const isNewSession = !this._currentSessionId;
						const sessionChanged = this._currentSessionId && this._currentSessionId !== jsonData.session_id;

						console.log('Session ID found in result:', {
							sessionId: jsonData.session_id,
							isNewSession,
							sessionChanged,
							currentSessionId: this._currentSessionId
						});

						this._currentSessionId = jsonData.session_id;

						// Show session info in UI
						this._sendAndSaveMessage({
							type: 'sessionInfo',
							data: {
								sessionId: jsonData.session_id,
								tools: jsonData.tools || [],
								mcpServers: jsonData.mcp_servers || []
							}
						});
					}

					// Clear processing state
					this._panel?.webview.postMessage({
						type: 'setProcessing',
						data: false
					});

					// Update cumulative tracking
					this._requestCount++;
					if (jsonData.total_cost_usd) {
						this._totalCost += jsonData.total_cost_usd;
					}

					console.log('Result received:', {
						cost: jsonData.total_cost_usd,
						duration: jsonData.duration_ms,
						turns: jsonData.num_turns
					});

					// Send updated totals to webview
					this._panel?.webview.postMessage({
						type: 'updateTotals',
						data: {
							totalCost: this._totalCost,
							totalTokensInput: this._totalTokensInput,
							totalTokensOutput: this._totalTokensOutput,
							requestCount: this._requestCount,
							currentCost: jsonData.total_cost_usd,
							currentDuration: jsonData.duration_ms,
							currentTurns: jsonData.num_turns
						}
					});
				}
				break;
		}
	}


	private _newSession() {
		// Clear current session
		this._currentSessionId = undefined;

		// Clear commits and conversation
		this._commits = [];
		this._currentConversation = [];
		this._conversationStartTime = undefined;

		// Reset counters
		this._totalCost = 0;
		this._totalTokensInput = 0;
		this._totalTokensOutput = 0;
		this._requestCount = 0;

		// Notify webview to clear all messages and reset session
		this._panel?.webview.postMessage({
			type: 'sessionCleared'
		});
	}

	private _handleLoginRequired() {
		// Clear processing state
		this._panel?.webview.postMessage({
			type: 'setProcessing',
			data: false
		});

		// Show login required message
		this._panel?.webview.postMessage({
			type: 'loginRequired'
		});

		// Open terminal and run claude login
		const terminal = vscode.window.createTerminal('Claude Login');
		terminal.sendText('claude');
		terminal.show();

		// Show info message
		vscode.window.showInformationMessage(
			'Please login to Claude in the terminal, then come back to this chat to continue.',
			'OK'
		);
	}

	private async _initializeBackupRepo(): Promise<void> {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) return;

			const storagePath = this._context.storageUri?.fsPath;
			if (!storagePath) {
				console.error('No workspace storage available');
				return;
			}
			console.log('Workspace storage path:', storagePath);
			this._backupRepoPath = path.join(storagePath, 'backups', '.git');

			// Create backup git directory if it doesn't exist
			try {
				await vscode.workspace.fs.stat(vscode.Uri.file(this._backupRepoPath));
			} catch {
				await vscode.workspace.fs.createDirectory(vscode.Uri.file(this._backupRepoPath));

				const workspacePath = workspaceFolder.uri.fsPath;

				// Initialize git repo with workspace as work-tree
				await exec(`git --git-dir="${this._backupRepoPath}" --work-tree="${workspacePath}" init`);
				await exec(`git --git-dir="${this._backupRepoPath}" config user.name "Claude Code Chat"`);
				await exec(`git --git-dir="${this._backupRepoPath}" config user.email "claude@anthropic.com"`);

				console.log(`Initialized backup repository at: ${this._backupRepoPath}`);
			}
		} catch (error: any) {
			console.error('Failed to initialize backup repository:', error.message);
		}
	}

	private async _createBackupCommit(userMessage: string): Promise<void> {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder || !this._backupRepoPath) return;

			const workspacePath = workspaceFolder.uri.fsPath;
			const now = new Date();
			const timestamp = now.toISOString().replace(/[:.]/g, '-');
			const displayTimestamp = now.toISOString();
			const commitMessage = `Before: ${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}`;

			// Add all files using git-dir and work-tree (excludes .git automatically)
			await exec(`git --git-dir="${this._backupRepoPath}" --work-tree="${workspacePath}" add -A`);

			// Check if this is the first commit (no HEAD exists yet)
			let isFirstCommit = false;
			try {
				await exec(`git --git-dir="${this._backupRepoPath}" rev-parse HEAD`);
			} catch {
				isFirstCommit = true;
			}

			// Check if there are changes to commit
			const { stdout: status } = await exec(`git --git-dir="${this._backupRepoPath}" --work-tree="${workspacePath}" status --porcelain`);

			// Always create a checkpoint, even if no files changed
			let actualMessage;
			if (isFirstCommit) {
				actualMessage = `Initial backup: ${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}`;
			} else if (status.trim()) {
				actualMessage = commitMessage;
			} else {
				actualMessage = `Checkpoint (no changes): ${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}`;
			}

			// Create commit with --allow-empty to ensure checkpoint is always created
			await exec(`git --git-dir="${this._backupRepoPath}" --work-tree="${workspacePath}" commit --allow-empty -m "${actualMessage}"`);
			const { stdout: sha } = await exec(`git --git-dir="${this._backupRepoPath}" rev-parse HEAD`);

			// Store commit info
			const commitInfo = {
				id: `commit-${timestamp}`,
				sha: sha.trim(),
				message: actualMessage,
				timestamp: displayTimestamp
			};

			this._commits.push(commitInfo);

			// Show restore option in UI and save to conversation
			this._sendAndSaveMessage({
				type: 'showRestoreOption',
				data: commitInfo
			});

			console.log(`Created backup commit: ${commitInfo.sha.substring(0, 8)} - ${actualMessage}`);
		} catch (error: any) {
			console.error('Failed to create backup commit:', error.message);
		}
	}


	private async _restoreToCommit(commitSha: string): Promise<void> {
		try {
			const commit = this._commits.find(c => c.sha === commitSha);
			if (!commit) {
				this._panel?.webview.postMessage({
					type: 'restoreError',
					data: 'Commit not found'
				});
				return;
			}

			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder || !this._backupRepoPath) {
				vscode.window.showErrorMessage('No workspace folder or backup repository available.');
				return;
			}

			const workspacePath = workspaceFolder.uri.fsPath;

			this._panel?.webview.postMessage({
				type: 'restoreProgress',
				data: 'Restoring files from backup...'
			});

			// Restore files directly to workspace using git checkout
			await exec(`git --git-dir="${this._backupRepoPath}" --work-tree="${workspacePath}" checkout ${commitSha} -- .`);

			vscode.window.showInformationMessage(`Restored to commit: ${commit.message}`);

			this._sendAndSaveMessage({
				type: 'restoreSuccess',
				data: {
					message: `Successfully restored to: ${commit.message}`,
					commitSha: commitSha
				}
			});

		} catch (error: any) {
			console.error('Failed to restore commit:', error.message);
			vscode.window.showErrorMessage(`Failed to restore commit: ${error.message}`);
			this._panel?.webview.postMessage({
				type: 'restoreError',
				data: `Failed to restore: ${error.message}`
			});
		}
	}

	private async _initializeConversations(): Promise<void> {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) return;

			const storagePath = this._context.storageUri?.fsPath;
			if (!storagePath) return;

			this._conversationsPath = path.join(storagePath, 'conversations');

			// Create conversations directory if it doesn't exist
			try {
				await vscode.workspace.fs.stat(vscode.Uri.file(this._conversationsPath));
			} catch {
				await vscode.workspace.fs.createDirectory(vscode.Uri.file(this._conversationsPath));
				console.log(`Created conversations directory at: ${this._conversationsPath}`);
			}
		} catch (error: any) {
			console.error('Failed to initialize conversations directory:', error.message);
		}
	}

	private _sendAndSaveMessage(message: { type: string, data: any }): void {
		// Initialize conversation if this is the first message
		if (this._currentConversation.length === 0) {
			this._conversationStartTime = new Date().toISOString();
		}

		if (message.type === 'sessionInfo') {
			message.data.sessionId
		}

		// Send to UI
		this._panel?.webview.postMessage(message);

		// Save to conversation
		this._currentConversation.push({
			timestamp: new Date().toISOString(),
			messageType: message.type,
			data: message.data
		});

		// Persist conversation
		void this._saveCurrentConversation();
	}

	private async _saveCurrentConversation(): Promise<void> {
		if (!this._conversationsPath || this._currentConversation.length === 0) return;

		try {
			// Create filename from first user message and timestamp
			const firstUserMessage = this._currentConversation.find(m => m.messageType === 'userInput');
			const firstMessage = firstUserMessage ? firstUserMessage.data : 'conversation';
			const startTime = this._conversationStartTime || new Date().toISOString();
			const sessionId = this._currentSessionId || 'unknown';

			// Clean and truncate first message for filename
			const cleanMessage = firstMessage
				.replace(/[^a-zA-Z0-9\s]/g, '') // Remove special chars
				.replace(/\s+/g, '-') // Replace spaces with dashes
				.substring(0, 50) // Limit length
				.toLowerCase();

			const datePrefix = startTime.substring(0, 16).replace('T', '_').replace(/:/g, '-');
			const filename = `${datePrefix}_${cleanMessage}.json`;

			const conversationData = {
				sessionId: sessionId,
				startTime: this._conversationStartTime,
				endTime: new Date().toISOString(),
				messageCount: this._currentConversation.length,
				totalCost: this._totalCost,
				totalTokens: {
					input: this._totalTokensInput,
					output: this._totalTokensOutput
				},
				messages: this._currentConversation,
				filename
			};

			const filePath = path.join(this._conversationsPath, filename);
			const content = new TextEncoder().encode(JSON.stringify(conversationData, null, 2));
			await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), content);

			// Update conversation index
			this._updateConversationIndex(filename, conversationData);

			console.log(`Saved conversation: ${filename}`, this._conversationsPath);
		} catch (error: any) {
			console.error('Failed to save conversation:', error.message);
		}
	}

	public setTreeProvider(treeProvider: ClaudeChatViewProvider): void {
		this._treeProvider = treeProvider;
	}

	public async loadConversation(filename: string): Promise<void> {
		// Show the webview first
		this.show();

		// Load the conversation history
		await this._loadConversationHistory(filename);
	}

	private _sendConversationList(): void {
		this._panel?.webview.postMessage({
			type: 'conversationList',
			data: this._conversationIndex
		});
	}

	private async _sendWorkspaceFiles(searchTerm?: string): Promise<void> {
		try {
			// Always get all files and filter on the backend for better search results
			const files = await vscode.workspace.findFiles(
				'**/*',
				'{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**,**/.nuxt/**,**/target/**,**/bin/**,**/obj/**}',
				500 // Reasonable limit for filtering
			);

			let fileList = files.map(file => {
				const relativePath = vscode.workspace.asRelativePath(file);
				return {
					name: file.path.split('/').pop() || '',
					path: relativePath,
					fsPath: file.fsPath
				};
			});

			// Filter results based on search term
			if (searchTerm && searchTerm.trim()) {
				const term = searchTerm.toLowerCase();
				fileList = fileList.filter(file => {
					const fileName = file.name.toLowerCase();
					const filePath = file.path.toLowerCase();
					
					// Check if term matches filename or any part of the path
					return fileName.includes(term) || 
						   filePath.includes(term) ||
						   filePath.split('/').some(segment => segment.includes(term));
				});
			}

			// Sort and limit results
			fileList = fileList
				.sort((a, b) => a.name.localeCompare(b.name))
				.slice(0, 50);

			this._panel?.webview.postMessage({
				type: 'workspaceFiles',
				data: fileList
			});
		} catch (error) {
			console.error('Error getting workspace files:', error);
			this._panel?.webview.postMessage({
				type: 'workspaceFiles',
				data: []
			});
		}
	}

	private async _selectImageFile(): Promise<void> {
		try {
			// Show VS Code's native file picker for images
			const result = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: true,
				title: 'Select image files',
				filters: {
					'Images': ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp']
				}
			});
			
			if (result && result.length > 0) {
				// Send the selected file paths back to webview
				result.forEach(uri => {
					this._panel?.webview.postMessage({
						type: 'imagePath',
						path: uri.fsPath
					});
				});
			}
			
		} catch (error) {
			console.error('Error selecting image files:', error);
		}
	}

	private _stopClaudeProcess(): void {
		console.log('Stop request received');
		
		if (this._currentClaudeProcess) {
			console.log('Terminating Claude process...');
			
			// Try graceful termination first
			this._currentClaudeProcess.kill('SIGTERM');
			
			// Force kill after 2 seconds if still running
			setTimeout(() => {
				if (this._currentClaudeProcess && !this._currentClaudeProcess.killed) {
					console.log('Force killing Claude process...');
					this._currentClaudeProcess.kill('SIGKILL');
				}
			}, 2000);
			
			// Clear process reference
			this._currentClaudeProcess = undefined;
			
			// Update UI state
			this._panel?.webview.postMessage({
				type: 'setProcessing',
				data: false
			});
			
			this._panel?.webview.postMessage({
				type: 'clearLoading'
			});
			
			// Send stop confirmation message directly to UI and save
			this._sendAndSaveMessage({
				type: 'error',
				data: '⏹️ Claude code was stopped.'
			});
			
			console.log('Claude process termination initiated');
		} else {
			console.log('No Claude process running to stop');
		}
	}

	private _updateConversationIndex(filename: string, conversationData: any): void {
		// Extract first and last user messages
		const userMessages = conversationData.messages.filter((m: any) => m.messageType === 'userInput');
		const firstUserMessage = userMessages.length > 0 ? userMessages[0].data : 'No user message';
		const lastUserMessage = userMessages.length > 0 ? userMessages[userMessages.length - 1].data : firstUserMessage;

		// Create or update index entry
		const indexEntry = {
			filename: filename,
			sessionId: conversationData.sessionId,
			startTime: conversationData.startTime,
			endTime: conversationData.endTime,
			messageCount: conversationData.messageCount,
			totalCost: conversationData.totalCost,
			firstUserMessage: firstUserMessage.substring(0, 100), // Truncate for storage
			lastUserMessage: lastUserMessage.substring(0, 100)
		};

		// Remove any existing entry for this session (in case of updates)
		this._conversationIndex = this._conversationIndex.filter(entry => entry.filename !== conversationData.filename);

		// Add new entry at the beginning (most recent first)
		this._conversationIndex.unshift(indexEntry);

		// Keep only last 50 conversations to avoid workspace state bloat
		if (this._conversationIndex.length > 50) {
			this._conversationIndex = this._conversationIndex.slice(0, 50);
		}

		// Save to workspace state
		this._context.workspaceState.update('claude.conversationIndex', this._conversationIndex);

		// Refresh tree view
		this._treeProvider?.refresh();
	}

	private _getLatestConversation(): any | undefined {
		return this._conversationIndex.length > 0 ? this._conversationIndex[0] : undefined;
	}

	private async _loadConversationHistory(filename: string): Promise<void> {
		console.log("_loadConversationHistory")
		if (!this._conversationsPath) return;

		try {
			const filePath = path.join(this._conversationsPath, filename);
			console.log("filePath", filePath)
			
			let conversationData;
			try {
				const fileUri = vscode.Uri.file(filePath);
				const content = await vscode.workspace.fs.readFile(fileUri);
				conversationData = JSON.parse(new TextDecoder().decode(content));
			} catch {
				return;
			}
			
			console.log("conversationData", conversationData)
			// Load conversation into current state
			this._currentConversation = conversationData.messages || [];
			this._conversationStartTime = conversationData.startTime;
			this._totalCost = conversationData.totalCost || 0;
			this._totalTokensInput = conversationData.totalTokens?.input || 0;
			this._totalTokensOutput = conversationData.totalTokens?.output || 0;

			// Clear UI messages first, then send all messages to recreate the conversation
			setTimeout(() => {
				// Clear existing messages
				this._panel?.webview.postMessage({
					type: 'sessionCleared'
				});

				// Small delay to ensure messages are cleared before loading new ones
				setTimeout(() => {
					for (const message of this._currentConversation) {
						this._panel?.webview.postMessage({
							type: message.messageType,
							data: message.data
						});
					}

					// Send updated totals
					this._panel?.webview.postMessage({
						type: 'updateTotals',
						data: {
							totalCost: this._totalCost,
							totalTokensInput: this._totalTokensInput,
							totalTokensOutput: this._totalTokensOutput,
							requestCount: this._requestCount
						}
					});
				}, 50);
			}, 100); // Small delay to ensure webview is ready

			console.log(`Loaded conversation history: ${filename}`);
		} catch (error: any) {
			console.error('Failed to load conversation history:', error.message);
		}
	}

	private _getHtmlForWebview(): string {
		return html
	}

	public dispose() {
		if (this._panel) {
			this._panel.dispose();
			this._panel = undefined;
		}

		while (this._disposables.length) {
			const disposable = this._disposables.pop();
			if (disposable) {
				disposable.dispose();
			}
		}
	}
}