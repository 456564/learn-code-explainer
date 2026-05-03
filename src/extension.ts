import * as vscode from 'vscode';
import { scanProject } from './projectScanner';
import { callOllamaStream, checkOllamaHealth } from './ollama';
import { buildPrompt } from './commentGenerator';
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
 *
 * 流程：
 * 1. Ollama 流式输出 token
 * 2. 按行累积（遇到 \n），检测 marker（--- 行 N ---）
 * 3. 看到 marker → 说明上一块完整 → 立即插入上一块
 * 4. 流结束后 flush 最后一个 pending 块
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
    channel.show(true); // 显示但不抢焦点

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
            const projectContext = await scanProject(fileUri);

            progress.report({ message: '🤖 Ollama 正在生成（注释将逐块插入）...' });

            const language = detectLanguage(filePath);
            const prompt = buildPrompt({
                selectedCode: selectedText,
                projectContext,
                language,
                filePath,
            });

            // ---- 渐进式插入状态 ----
            let lineBuffer = '';                           // 当前行缓冲区
            let pending: PendingBlock | null = null;      // 待插入的注释块
            let lineOffset = 0;                            // 累积插入行数偏移
            const insertedLines = new Set<number>();       // 已插入的行号（去重）
            let insertedCount = 0;                         // 已插入块数

            // ---- 辅助函数：插入注释块 ----
            async function insertPending(block: PendingBlock): Promise<boolean> {
                if (insertedLines.has(block.lineNum)) {
                    return false;
                }

                const comment = block.content.trim();
                if (!comment) {
                    return false;
                }

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
                    const insertedLineCount = formatted.split('\n').length;
                    lineOffset += insertedLineCount;
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
                // 匹配 marker: --- 行 N ---
                const match = trimmed.match(/^---\s*行\s*(\d+)\s*---$/i);

                if (match) {
                    // 这是 marker 行
                    const lineNum = parseInt(match[1], 10);

                    // 插入上一块（如果有）
                    if (pending) {
                        await insertPending(pending);
                        pending = null;
                    }

                    // 当前 marker 的注释内容等下一行
                    pending = { lineNum, content: '' };
                } else {
                    // 普通行：追加到 pending 内容
                    if (pending) {
                        pending.content += line;
                    }
                }
            }

            // ---- 流式读取 Ollama ----
            channel.append('🤖 ');
            let charCount = 0;

            for await (const token of callOllamaStream({ prompt })) {
                charCount += token.length;
                lineBuffer += token;

                // Output Channel 打字机效果
                channel.append(token);

                // 持续处理完整行（可能多个）
                while (true) {
                    const newlineIndex = lineBuffer.indexOf('\n');
                    if (newlineIndex === -1) {
                        break; // 没有完整行，等待更多 token
                    }

                    // 提取一行
                    const line = lineBuffer.slice(0, newlineIndex + 1);
                    lineBuffer = lineBuffer.slice(newlineIndex + 1);

                    // 处理这一行
                    await processLine(line);

                    // 进度更新（每插入 3 块更新一次通知）
                    if (insertedCount > 0 && insertedCount % 3 === 0) {
                        progress.report({ message: `🤖 已插入 ${insertedCount} 处注释...` });
                    }
                }

                // 全局进度通知（避免过于频繁）
                if (charCount % 500 === 0) {
                    progress.report({ message: `🤖 已生成 ${charCount} 字符...` });
                }
            }

            // ---- 流结束：处理残留 ----
            // lineBuffer 中可能还有最后一行（没有 \n 结尾）
            if (lineBuffer.trim()) {
                await processLine(lineBuffer);
            }

            // 插入最后一个 pending 块
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
