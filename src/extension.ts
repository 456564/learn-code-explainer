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
 * 核心逻辑：详解选中代码
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

            progress.report({ message: '📝 整理注释格式...' });

            // 7. 解析 + 格式化
            const parsed = parseCommentResponse(rawResponse);
            if (!parsed) {
                vscode.window.showWarningMessage('Ollama 返回了空结果，请重试。');
                return;
            }

            const formatted = formatCommentBlock(parsed);

            // 8. 获取选中区域的尾行（插入位置）
            const lastLine = selection.end.line;
            const insertPosition = new vscode.Position(lastLine + 1, 0);

            // 9. 插入注释
            await editor.edit(editBuilder => {
                editBuilder.insert(insertPosition, '\n' + formatted + '\n');
            });

            // 10. 滚动到插入位置
            const newPosition = new vscode.Position(lastLine + 1, 0);
            editor.selection = new vscode.Selection(newPosition, newPosition);
            editor.revealRange(
                new vscode.Range(lastLine + 1, 0, lastLine + 1, 0),
                vscode.TextEditorRevealType.InCenter
            );

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
