import * as vscode from 'vscode';
import { scanProject } from './projectScanner';
import { callOllama, checkOllamaHealth } from './ollama';
import { buildPrompt, parseCommentResponse } from './commentGenerator';
import { formatCommentBlock } from './formatter';
import { getConfig } from './settings';

export function activate(context: vscode.ExtensionContext) {

    // 注册命令
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
 * 从 Ollama 返回中解析出行号 → 注释块的映射
 * 返回 Map<相对于选中代码的行号(从1开始), 格式化后的注释字符串>
 */
function parseNumberedComments(raw: string): Map<number, string> {
    const result = new Map<number, string>();
    // 按 "--- 行 N ---" 分割
    const sections = raw.split(/---?\s*行\s*(\d+)\s*---?/i);
    // sections[0] 是第一个分隔符之前的内容（忽略）
    // sections[1] = 行号1, sections[2] = 注释内容1, sections[3] = 行号2, ...
    for (let i = 1; i < sections.length; i += 2) {
        const lineNum = parseInt(sections[i].trim(), 10);
        if (isNaN(lineNum)) { continue; }
        let comment = sections[i + 1] || '';
        // 格式化注释块
        comment = formatCommentBlock(comment.trim());
        if (comment) {
            result.set(lineNum, comment);
        }
    }
    return result;
}

/**
 * 核心逻辑：详解选中代码
 * 策略：Ollama 返回带行号的注释块，插件逐行插入到对应代码行下方
 */
async function explainSelectedCode(): Promise<void> {
    // 1. 获取选中的代码
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

    // 选中代码在文件中的起始行（0-based）
    const startLine = selection.start.line;

    // 2. 检查 Ollama 是否可用
    const ollamaAvailable = await checkOllamaHealth();
    if (!ollamaAvailable) {
        const choice = await vscode.window.showErrorMessage(
            '❌ 无法连接到 Ollama\n请确保 Ollama 已安装并运行。',
            '打开 Ollama 下载页', '打开设置'
        );
        if (choice === '打开 Ollama 下载页') {
            vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
        } else if (choice === '打开设置') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'learnCodeExplainer');
        }
        return;
    }

    // 3. 展示进度
    const progressOptions: vscode.ProgressOptions = {
        location: vscode.ProgressLocation.Notification,
        title: '📖 正在生成学习型注释...',
        cancellable: false,
    };

    await vscode.window.withProgress(progressOptions, async (progress) => {
        try {
            progress.report({ message: '🔍 扫描工程上下文...' });
            const doc = editor.document;
            const fileUri = doc.uri;
            const filePath = doc.fileName;

            // 4. 扫描工程
            const projectContext = await scanProject(fileUri);

            progress.report({ message: '🤖 调用 Ollama 生成注释...' });

            // 5. 构造 Prompt
            const language = detectLanguage(filePath);
            const prompt = buildPrompt({
                selectedCode: selectedText,
                projectContext,
                language,
                filePath,
            });

            // 6. 调用 Ollama
            const rawResponse = await callOllama({ prompt });

            progress.report({ message: '📝 解析注释并插入...' });

            // 7. 解析带行号的注释块
            const commentMap = parseNumberedComments(rawResponse);
            if (commentMap.size === 0) {
                vscode.window.showWarningMessage('Ollama 返回了空结果或格式异常，请重试。');
                return;
            }

            // 8. 从下往上插入注释（避免行号偏移）
            // 按行号降序排列
            const lineNums = Array.from(commentMap.keys()).sort((a, b) => b - a);

            await editor.edit(editBuilder => {
                for (const relLineNum of lineNums) {
                    // 绝对行号 = 起始行 + 相对行号(1-based转为0-based)
                    const absLine = startLine + (relLineNum - 1);
                    const comment = commentMap.get(relLineNum)!;
                    const insertPos = new vscode.Position(absLine + 1, 0);
                    editBuilder.insert(insertPos, comment + '\n');
                }
            });

            progress.report({ message: '✅ 注释生成完成！' });

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`生成失败: ${message}`);
            console.error('[LearnCodeExplainer]', message);
        }
    });
}

/**
 * 根据文件扩展名判断语言
 */
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
