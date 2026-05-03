import * as vscode from 'vscode';
import { buildSymbolIndex, buildSummary, detectProjectType } from './projectScanner';
import { callOllamaStream, checkOllamaHealth } from './ollama';
import { buildDeepPrompt } from './commentGenerator';
import { resolveCallChain } from './callGraph';
import { formatCommentBlock } from './formatter';
import { getConfig } from './settings';

/** 流式输出通道 */
let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Learn Code Explainer');
    }
    return outputChannel;
}

export function activate(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand(
        'learnCodeExplainer.explainCode',
        async () => {
            await explainSelectedCode();
        }
    );
    context.subscriptions.push(disposable);
}

export function deactivate() {}

interface PendingBlock {
    lineNum: number;
    content: string;
}

/**
 * 核心逻辑：流式生成 + 渐进式按行插入
 * 增强版：包含符号索引和调用链解析
 */
async function explainSelectedCode(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('没有活动编辑器，请先打开一个代码文件。');
        return;
    }

    const selection = editor.selection;
    const selectedText = editor.document.getText(selection).trim();
    if (!selectedText) {
        vscode.window.showWarningMessage('请先选中要详解的代码。');
        return;
    }

    const startLine = selection.start.line;
    const channel = getOutputChannel();
    channel.clear();
    channel.show(true);

    // 健康检查
    const ollamaAvailable = await checkOllamaHealth();
    if (!ollamaAvailable) {
        const choice = await vscode.window.showErrorMessage(
            '❌ 无法连接到 Ollama\n请确保 Ollama 已安装并运行。',
            '打开 Ollama 下载页',
            '打开设置'
        );
        if (choice === '打开 Ollama 下载页') {
            vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
        } else if (choice === '打开设置') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'learnCodeExplainer');
        }
        return;
    }

    const progressOptions: vscode.ProgressOptions = {
        location: vscode.ProgressLocation.Notification,
        title: '📖 正在生成注释',
        cancellable: false,
    };

    await vscode.window.withProgress(progressOptions, async (progress) => {
        try {
            progress.report({ message: '🔍 扫描工程上下文...' });
            channel.appendLine('🔍 正在扫描工程上下文...\n');

            const doc = editor.document;
            const fileUri = doc.uri;
            const filePath = doc.fileName;

            // ---- 构建符号索引（带缓存）----
            progress.report({ message: '📊 构建符号索引...' });
            channel.appendLine('📊 构建符号索引...\n');

            const symbolIndex = await buildSymbolIndex(fileUri);
            const projectType = detectProjectType(symbolIndex.rootPath || path.dirname(filePath));
            const summary = buildSummary(projectType, symbolIndex);

            // ---- 解析调用链 ----
            progress.report({ message: '🔗 解析调用链...' });
            channel.appendLine('🔗 解析函数调用链...\n');

            const relFilePath = symbolIndex.rootPath
                ? path.relative(symbolIndex.rootPath, filePath)
                : filePath;

            const callChain = await resolveCallChain(
                selectedText,
                symbolIndex,
                relFilePath,
                3500  // 最多 3500 tokens 给上下文
            );

            if (callChain.definitions.length > 0) {
                channel.appendLine(`  ✅ 找到 ${callChain.definitions.length} 个相关函数/结构体`);
                for (const def of callChain.definitions.slice(0, 5)) {
                    channel.appendLine(`     - ${def.name} (${def.file}:${def.line})`);
                }
                if (callChain.definitions.length > 5) {
                    channel.appendLine(`     ... 还有 ${callChain.definitions.length - 5} 个`);
                }
            }
            if (callChain.unresolvedNames.length > 0) {
                channel.appendLine(`  ⚠️ ${callChain.unresolvedNames.length} 个无法解析（可能是标准库/内置）`);
            }

            // ---- 构建深度上下文 Prompt ----
            progress.report({ message: '🤖 Ollama 正在生成（带深度上下文）...' });

            const language = detectLanguage(filePath);
            const projectContext = { rootPath: symbolIndex.rootPath || '', projectType, symbolIndex, summary };

            const prompt = buildDeepPrompt({
                selectedCode: selectedText,
                projectContext,
                callChain,
                language,
                filePath,
            });

            // ---- 渐进式插入状态 ----
            let lineBuffer = '';
            let pending: PendingBlock | null = null;
            let lineOffset = 0;
            const insertedLines = new Set<number>();
            let insertedCount = 0;

            // ---- 辅助函数：插入注释块 ----
            async function insertPending(block: PendingBlock): Promise<boolean> {
                if (insertedLines.has(block.lineNum)) return false;

                const comment = block.content.trim();
                if (!comment) return false;

                const formatted = formatCommentBlock(comment);
                const absLine = startLine + (block.lineNum - 1) + lineOffset;

                try {
                    if (!editor) return false;
                    await editor.edit(editBuilder => {
                        editBuilder.insert(
                            new vscode.Position(absLine + 1, 0),
                            formatted + '\n'
                        );
                    });

                    insertedLines.add(block.lineNum);
                    lineOffset += formatted.split('\n').length;
                    insertedCount++;

                    channel.appendLine(`  ✅ [行 ${block.lineNum}] 已插入`);
                    return true;
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    channel.appendLine(`  ⚠️ [行 ${block.lineNum}] 插入失败: ${msg}`);
                    return false;
                }
            }

            // ---- 辅助函数：处理一行完整文本 ----
            async function processLine(line: string): Promise<void> {
                const trimmed = line.trim();
                const match = trimmed.match(/^---\s*行\s*(\d+)\s*---$/i);

                if (match) {
                    const lineNum = parseInt(match[1], 10);
                    if (pending) {
                        await insertPending(pending);
                        pending = null;
                    }
                    pending = { lineNum, content: '' };
                } else {
                    if (pending) {
                        pending.content += line;
                    }
                }
            }

            // ---- 流式读取 Ollama ----
            channel.append('\n🤖 ');
            let charCount = 0;

            for await (const token of callOllamaStream({ prompt })) {
                charCount += token.length;
                lineBuffer += token;

                channel.append(token);

                while (true) {
                    const newlineIndex = lineBuffer.indexOf('\n');
                    if (newlineIndex === -1) break;

                    const line = lineBuffer.slice(0, newlineIndex + 1);
                    lineBuffer = lineBuffer.slice(newlineIndex + 1);

                    await processLine(line);

                    if (insertedCount > 0 && insertedCount % 3 === 0) {
                        progress.report({ message: `🤖 已插入 ${insertedCount} 处注释...` });
                    }
                }

                if (charCount % 500 === 0) {
                    progress.report({ message: `🤖 已生成 ${charCount} 字符...` });
                }
            }

            // ---- 流结束：处理残留 ----
            if (lineBuffer.trim()) {
                await processLine(lineBuffer);
            }
            if (pending) {
                await insertPending(pending);
                pending = null;
            }

            channel.appendLine(`\n✅ 注释生成完成！共插入 ${insertedCount} 处注释。`);
            progress.report({ message: '✅ 注释生成完成！' });

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            channel.appendLine(`\n❌ 错误：${message}`);
            vscode.window.showErrorMessage(`生成失败: ${message}`);
            console.error('[LearnCodeExplainer]', message);
        }
    });
}

function detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const map: Record<string, string> = {
        'c': 'c', 'h': 'c',
        'cpp': 'cpp', 'cc': 'cpp', 'cxx': 'cpp', 'hpp': 'cpp',
        'py': 'python',
        'js': 'javascript',
        'ts': 'typescript',
        'tsx': 'typescript',
        'java': 'java',
        'go': 'go',
        'rs': 'rust',
        'rb': 'ruby',
        'php': 'php',
        'swift': 'swift',
        'kt': 'kotlin',
        'cs': 'csharp',
        'm': 'objective-c',
        'mm': 'objective-cpp',
        'sh': 'bash',
        'lua': 'lua',
        'zig': 'zig',
    };
    return map[ext] || 'text';
}

// 引入 path（需要用于相对路径计算）
import * as path from 'path';
