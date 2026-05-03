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

/**
 * 解析 "--- 行 N ---" 格式的注释块
 * 返回 Map<相对行号(1-based), 注释文本>
 */
function parseNumberedComments(raw: string): Map<number, string> {
    const result = new Map<number, string>();
    // 按分隔符分割：--- 行 N ---
    const parts = raw.split(/---\s*行\s*(\d+)\s*---/i);
    // parts[0] = 前言（忽略）
    // parts[1] = 行号1, parts[2] = 注释内容1, parts[3] = 行号2, ...
    for (let i = 1; i < parts.length; i += 2) {
        const lineNumStr = parts[i]?.trim();
        if (!lineNumStr) continue;
        const lineNum = parseInt(lineNumStr, 10);
        if (isNaN(lineNum) || lineNum <= 0) continue;
        const commentRaw = (parts[i + 1] || '').trim();
        const formatted = formatCommentBlock(commentRaw);
        if (formatted) {
            result.set(lineNum, formatted);
        }
    }
    return result;
}

/**
 * 核心逻辑：流式生成 + 打字机效果
 *
 * 打字机效果实现方式：
 * 1. 开启 Ollama 流式 API，token 逐个到达
 * 2. 每个 token 实时追加到 Output Channel（可见的打字机效果）
 * 3. 流式结束后，一次性解析并插入所有注释到编辑器
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
        title: '📖 正在生成注释（流式）',
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

            progress.report({ message: '🤖 Ollama 正在生成（可在 Output 面板查看实时输出）...' });
            channel.appendLine('🤖 正在调用 Ollama 生成注释...\n');

            const language = detectLanguage(filePath);
            const prompt = buildPrompt({
                selectedCode: selectedText,
                projectContext,
                language,
                filePath,
            });

            // ---- 流式读取 Ollama ----
            let fullResponse = '';
            let charCount = 0;

            channel.append('🤖 ');
            for await (const token of callOllamaStream({ prompt })) {
                fullResponse += token;
                charCount += token.length;
                channel.append(token);

                // 每 200 字符更新一次进度通知（避免频繁刷新）
                if (charCount % 200 === 0) {
                    progress.report({ message: `🤖 已生成 ${charCount} 字符...` });
                }
            }

            channel.appendLine('\n\n✅ 流式生成完成！正在解析并插入注释...\n');
            progress.report({ message: '📝 解析注释并插入...' });

            // ---- 解析并插入注释 ----
            const commentMap = parseNumberedComments(fullResponse);

            if (commentMap.size === 0) {
                // 降级：无法解析出行号，把全文当成一个注释块插入到选中代码后面
                channel.appendLine('⚠️ 未检测到行号格式，将完整输出插入到代码末尾。');
                const formatted = formatCommentBlock(fullResponse);
                if (formatted) {
                    const endLine = selection.end.line;
                    await editor.edit(editBuilder => {
                        editBuilder.insert(new vscode.Position(endLine + 1, 0), '\n' + formatted + '\n');
                    });
                } else {
                    vscode.window.showWarningMessage('Ollama 返回了空结果或格式异常，请重试。');
                }
                return;
            }

            // 从下往上插入（避免行号偏移）
            const lineNums = Array.from(commentMap.keys()).sort((a, b) => b - a);

            await editor.edit(editBuilder => {
                for (const relLineNum of lineNums) {
                    const absLine = startLine + (relLineNum - 1);
                    const comment = commentMap.get(relLineNum)!;
                    editBuilder.insert(new vscode.Position(absLine + 1, 0), comment + '\n');
                }
            });

            channel.appendLine(`✅ 已插入 ${commentMap.size} 处注释！`);
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
