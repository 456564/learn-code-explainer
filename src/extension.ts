import * as vscode from 'vscode';
import * as fs from 'fs';
import { buildSymbolIndex, buildSummary, detectProjectType, findProjectRoot } from './projectScanner';
import { callOllamaStream, checkOllamaHealth } from './ollama';
import { buildDeepPrompt } from './commentGenerator';
import { resolveCallChain, resolveClassChain } from './callGraph';
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

interface CallSite {
    file: string;
    line: number;
    snippet: string;   // 完整调用语句
    args: string[];    // 拆解后的各实参
}

interface PendingBlock {
    lineNum: number;       // AI 报的相对行号（1-based）
    codeSnippet: string;    // 该行代码原文（从 selectedLines 取，用于插入前模糊校验）
    content: string;        // 注释内容（AI 生成）
}

/**
 * 从多行文本中提取函数名（支持 CUDA __global__ 跨行写法）
 */
function extractFunctionName(selectedText: string): string | null {
    // 先把多行合并成单行，去掉多余空白
    const singleLine = selectedText.replace(/\s+/g, ' ').trim();
    const match = singleLine.match(/(?:__global__|__device__|__host__|static|inline|extern)?\s*([\w:]+)\s*\(/);
    return match ? match[1] : null;
}

/**
 * 查找函数的调用点（在工程内搜索被选函数的实际调用位置）
 * 重写：使用 VS Code 搜索 API，支持 CUDA 语法
 */
async function findCallSites(
    selectedText: string,
    rootPath: string,
    channel: vscode.OutputChannel,
    currentFilePath?: string   // 传入当前文件，跳过该文件内的"定义行"检测
): Promise<CallSite[]> {
    const fnName = extractFunctionName(selectedText);
    if (!fnName) {
        channel.appendLine('  ⚠️ 无法从选中代码提取函数名');
        return [];
    }
    if (fnName.length < 3) {
        channel.appendLine('  ⚠️ 函数名太短，跳过调用点搜索');
        return [];
    }
    channel.appendLine(`  🔍 函数名: ${fnName}`);

    const results: CallSite[] = [];
    const maxResults = 5;

    try {
        const searchTargets = rootPath
            ? [vscode.Uri.file(rootPath)]
            : vscode.workspace.workspaceFolders?.map(f => f.uri) || [];

        if (searchTargets.length === 0) {
            channel.appendLine('  ⚠️ 未打开工作区文件夹，无法搜索调用点');
            return [];
        }

        // findFiles 搜索所有代码文件
        const textSearchResults = await vscode.workspace.findFiles(
            rootPath ? new vscode.RelativePattern(rootPath, '**/*') : '**/*',
            '**/node_modules/**',
            50
        );

        // 过滤出代码文件
        const codeExtensions = new Set(['c', 'cpp', 'h', 'hpp', 'cu', 'cuh', 'cc', 'cxx', 'm', 'mm', 'swift', 'java', 'go', 'rs', 'py', 'ts', 'js']);
        const codeFiles = textSearchResults.filter(uri => {
            const ext = uri.fsPath.split('.').pop()?.toLowerCase() || '';
            return codeExtensions.has(ext);
        });

        channel.appendLine(`  🔍 搜索 ${codeFiles.length} 个代码文件...`);

        for (const fileUri of codeFiles) {
            if (results.length >= maxResults) break;

            const doc = await vscode.workspace.openTextDocument(fileUri);
            const text = doc.getText();
            const lines = text.split('\n');

            // ---- 关键修复：搜索策略 ----
            // 普通函数调用: fnName(args)    → 搜索 token = fnName + '('
            // CUDA    调用: fnName<<<...>>>(args) → 搜索 token = fnName + '<'
            // 两种 token 都要搜，确保不错过任何一种
            const searchTokens = [
                fnName + '<',   // CUDA: fnName<<<...>>>(...)   ← 这是主要遗漏
                fnName + '(',   // 普通: fnName(...)
            ];

            for (const searchToken of searchTokens) {
                if (results.length >= maxResults) break;

                let pos = 0;
                while ((pos = text.indexOf(searchToken, pos)) !== -1) {
                    if (results.length >= maxResults) break;

                    // 计算行号
                    const beforeMatch = text.substring(0, pos);
                    const lineNum = beforeMatch.split('\n').length;
                    const lineText = (lines[lineNum - 1] || '').trim();

                    // ---- 排除定义行 ----
                    // 如果是当前文件：检查该行是否像函数定义（有返回类型 + 函数名）
                    // 如果不是当前文件：仍需排除该文件的定义行
                    if (lineText === fnName + '<' || lineText === fnName + '(') {
                        // 函数名单独一行 = 不是调用
                        pos++;
                        continue;
                    }
                    // 有返回类型的函数定义行（有空格分隔符）
                    const defPattern = /^\s*(?:void|int|float|char|double|bool|auto|\w+_t|const\s+\w+|\w+\s*\*?\s*|__global__|__device__|__host__|inline|static|extern)+\s+\w+\s*\(/;
                    if (defPattern.test(lineText)) {
                        pos++;
                        continue;
                    }

                    // ---- 提取完整调用语句 ----
                    // 往前找语句开始（遇到 ; { = + - * / \n 或 { 停止）
                    let callStart = pos;
                    while (callStart > 0 && !/[;{\n=+\-*\/]/.test(text[callStart - 1])) {
                        callStart--;
                    }

                    // 往后找语句结束：
                    // - CUDA: fnName<<<...>>>(...)  → depth 追踪 <>: 从 3 开始(<<<为3)，遇到>>>为0
                    // - 普通: fnName(...)           → depth 追踪 (): 从 1 开始
                    let callEnd = pos + searchToken.length;
                    let depth: number;
                    if (searchToken === fnName + '<') {
                        // CUDA <<<...>>>(...) 语法：<<< 计为3层尖括号
                        depth = 3; // 第一个 '<' 开始，等于遇到 '>>>' 才归零
                    } else {
                        depth = 1; // 第一个 '(' 开始
                    }

                    while (callEnd < text.length && depth > 0) {
                        const ch = text[callEnd];
                        if (ch === '(' || ch === '<') {
                            depth++;
                        } else if (ch === ')') {
                            depth--;
                        } else if (ch === '>') {
                            // CUDA: '>>>' 连着三个 >，需要特殊处理
                            // 检查是否是 '>>>'（连续三个 >）
                            if (searchToken === fnName + '<' && text.slice(callEnd, callEnd + 3) === '>>>') {
                                depth -= 3;
                                callEnd += 3; // 跳过三个 >
                                if (depth <= 0) {
                                    // 语句结束：往后找到分号
                                    while (callEnd < text.length && /\s/.test(text[callEnd])) callEnd++;
                                    if (text[callEnd] === ')') {
                                        callEnd++;
                                        while (callEnd < text.length && /\s/.test(text[callEnd])) callEnd++;
                                    }
                                    if (text[callEnd] === ';') {
                                        callEnd++;
                                    }
                                    break;
                                }
                                continue;
                            } else {
                                depth--;
                            }
                        }
                        callEnd++;
                    }

                    const callSnippet = text.substring(callStart, callEnd).replace(/\n/g, ' ').trim();

                    // ---- 提取参数 ----
                    // 找左括号位置（CUDA 有 <<<>>> 两组，普通只有一组）
                    let argOpenPos: number;
                    if (searchToken === fnName + '<') {
                        // CUDA: 第一个 '(' 是 <<< 里的，第二个 '(' 才是参数
                        argOpenPos = text.indexOf('(', pos + searchToken.length);
                        if (argOpenPos === -1 || argOpenPos >= callEnd) {
                            pos = callEnd;
                            continue;
                        }
                    } else {
                        argOpenPos = pos + fnName.length; // pos 是 fnName + '(' 的位置
                    }
                    const argsStr = extractArgsFromCall(text, argOpenPos + 1);
                    const args = parseArguments(argsStr);

                    // ---- 去重 ----
                    const snippetKey = callSnippet.substring(0, 60);
                    if (results.some(r => r.snippet.substring(0, 60) === snippetKey)) {
                        pos = callEnd;
                        continue;
                    }

                    results.push({
                        file: vscode.workspace.asRelativePath(fileUri),
                        line: lineNum,
                        snippet: callSnippet.length > 120 ? callSnippet.substring(0, 120) + '...' : callSnippet,
                        args,
                    });

                    channel.appendLine(`     ✅ 找到调用: ${fnName} → ${callSnippet.substring(0, 80)}`);

                    pos = callEnd;
                }
            }
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        channel.appendLine(`  ⚠️ 搜索调用点出错: ${msg}`);
        console.warn('[findCallSites]', e);
    }

    return results;
}

/**
 * 从函数调用位置提取参数字符串
 */
function extractArgsFromCall(text: string, openParenPos: number): string {
    let depth = 0;
    let i = openParenPos;
    // 找到匹配的右括号
    while (i < text.length) {
        const ch = text[i];
        if (ch === '(' || ch === '<') depth++;
        else if (ch === ')' || ch === '>') {
            depth--;
            if (depth === 0) {
                return text.substring(openParenPos, i);
            }
        }
        i++;
    }
    return '';
}

/**
 * 解析函数实参字符串，返回各实参的数组
 * 处理嵌套括号和模板，如 foo(a, bar(x, y), z)
 */
function parseArguments(argsStr: string): string[] {
    const result: string[] = [];
    let depth = 0;
    let current = '';

    for (const ch of argsStr) {
        if (ch === '(' || ch === '<' || ch === '{') {
            depth++;
            current += ch;
        } else if (ch === ')' || ch === '>' || ch === '}') {
            depth--;
            current += ch;
        } else if (ch === ',' && depth === 0) {
            result.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }

    if (current.trim()) {
        result.push(current.trim());
    }

    return result;
}

/**
 * 类实例化点
 */
interface ClassSite {
    file: string;
    line: number;
    snippet: string;   // 完整实例化语句
    className: string; // 被实例化的类名
    args: string[];    // 实参
}

/**
 * 从多行文本中提取类名（支持 C++/Python/JS 语法）
 */
function extractClassName(selectedText: string): string | null {
    const singleLine = selectedText.replace(/\s+/g, ' ').trim();

    // C++/Java 类定义: class ClassName 或 struct StructName
    const cppMatch = singleLine.match(/(?:class|struct)\s+([A-Z][a-zA-Z0-9_]*)/);
    if (cppMatch) return cppMatch[1];

    // Python 类定义: class ClassName
    const pyMatch = singleLine.match(/class\s+([A-Z][a-zA-Z0-9_]*)/);
    if (pyMatch) return pyMatch[1];

    // JS/TS 类定义: class ClassName
    const jsMatch = singleLine.match(/class\s+([A-Z][a-zA-Z0-9_]*)/);
    if (jsMatch) return jsMatch[1];

    return null;
}

/**
 * 查找类的实例化点（在工程内搜索被选类的实际实例化/继承位置）
 */
async function findClassSites(
    selectedText: string,
    rootPath: string,
    channel: vscode.OutputChannel,
    currentFilePath?: string
): Promise<ClassSite[]> {
    const className = extractClassName(selectedText);
    if (!className) {
        channel.appendLine('  ⚠️ 无法从选中代码提取类名');
        return [];
    }
    if (className.length < 2) {
        channel.appendLine('  ⚠️ 类名太短，跳过实例化点搜索');
        return [];
    }
    channel.appendLine(`  🔍 类名: ${className}`);

    const results: ClassSite[] = [];
    const maxResults = 5;

    try {
        const searchTargets = rootPath
            ? [vscode.Uri.file(rootPath)]
            : vscode.workspace.workspaceFolders?.map(f => f.uri) || [];

        if (searchTargets.length === 0) {
            channel.appendLine('  ⚠️ 未打开工作区文件夹，无法搜索实例化点');
            return [];
        }

        const textSearchResults = await vscode.workspace.findFiles(
            rootPath ? new vscode.RelativePattern(rootPath, '**/*') : '**/*',
            '**/node_modules/**',
            50
        );

        // 过滤代码文件
        const codeExtensions = new Set(['cpp', 'hpp', 'h', 'c', 'cc', 'cxx', 'py', 'js', 'ts', 'tsx', 'java', 'go', 'rs']);
        const codeFiles = textSearchResults.filter(uri => {
            const ext = uri.fsPath.split('.').pop()?.toLowerCase() || '';
            return codeExtensions.has(ext);
        });

        channel.appendLine(`  🔍 搜索 ${codeFiles.length} 个代码文件...`);

        for (const fileUri of codeFiles) {
            if (results.length >= maxResults) break;

            const doc = await vscode.workspace.openTextDocument(fileUri);
            const text = doc.getText();
            const lines = text.split('\n');

            // 搜索实例化模式：
            // 1. new ClassName(...)
            // 2. ClassName var(args) - C++ stack allocation
            // 3. ClassName(args) - C++ temporary
            // 4. class ClassName : public Base - 继承
            const searchPatterns = [
                `new ${className}(`,        // new ClassName(...)
                `${className}(`,             // ClassName(...) or var ClassName(...)
            ];

            for (const pattern of searchPatterns) {
                if (results.length >= maxResults) break;

                let pos = 0;
                while ((pos = text.indexOf(pattern, pos)) !== -1) {
                    if (results.length >= maxResults) break;

                    // 计算行号
                    const beforeMatch = text.substring(0, pos);
                    const lineNum = beforeMatch.split('\n').length;
                    const lineText = (lines[lineNum - 1] || '').trim();

                    // 跳过类定义行
                    if (lineText.includes(`class ${className}`) || lineText.includes(`struct ${className}`)) {
                        pos += pattern.length;
                        continue;
                    }

                    // 跳过 new/delete 关键字前没有空格的情况（如变量名包含类名）
                    if (/[a-z]/.test(text[pos - 1] || '')) {
                        pos += pattern.length;
                        continue;
                    }

                    // 提取完整实例化语句
                    const snippet = extractClassInstantiation(text, pos + pattern.indexOf('('));

                    // 去重
                    if (results.some(r => r.snippet.substring(0, 50) === snippet.substring(0, 50))) {
                        pos += snippet.length;
                        continue;
                    }

                    // 提取参数
                    const parenStart = pos + pattern.indexOf('(');
                    const argsStr = extractArgsFromCall(text, parenStart + 1);
                    const args = parseArguments(argsStr);

                    results.push({
                        file: vscode.workspace.asRelativePath(fileUri),
                        line: lineNum,
                        snippet,
                        className,
                        args,
                    });

                    channel.appendLine(`     ✅ 找到实例化: ${className} → ${snippet.substring(0, 60)}`);

                    pos += snippet.length;
                }
            }

            // 搜索继承关系：class Derived : public Base
            if (results.length < maxResults) {
                const inheritPattern = new RegExp(`class\\s+(\\w+)\\s*:\\s*(?:public\\s+)?${className}(?:::[^,{]+)?(?:\\{|,)`, 'g');
                let match;
                while ((match = inheritPattern.exec(text)) !== null) {
                    if (results.length >= maxResults) break;

                    const derivedClass = match[1];
                    const beforeMatch = text.substring(0, match.index);
                    const lineNum = beforeMatch.split('\n').length;
                    const lineText = (lines[lineNum - 1] || '').trim();

                    const snippet = `class ${derivedClass} : ${match[0].substring(match[0].indexOf(':'))}`;

                    results.push({
                        file: vscode.workspace.asRelativePath(fileUri),
                        line: lineNum,
                        snippet,
                        className,
                        args: [],
                    });

                    channel.appendLine(`     ✅ 找到继承: ${derivedClass} : public ${className}`);
                }
            }
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        channel.appendLine(`  ⚠️ 搜索实例化点出错: ${msg}`);
        console.warn('[findClassSites]', e);
    }

    return results;
}

/**
 * 从实例化位置提取完整语句
 */
function extractClassInstantiation(text: string, openParenPos: number): string {
    // 往前找语句开始
    let start = openParenPos;
    while (start > 0 && !/[;{\n=]/.test(text[start - 1])) {
        start--;
    }

    // 往后找到分号或括号平衡
    let end = openParenPos;
    let depth = 0;
    let started = false;

    while (end < text.length) {
        const ch = text[end];
        if (ch === '(' || ch === '<') {
            depth++;
            started = true;
        } else if (ch === ')' || ch === '>') {
            if (!started) break;
            depth--;
            if (depth === 0) {
                end++;
                // 跳过可能的 { (初始化列表)
                while (end < text.length && /\s/.test(text[end])) end++;
                if (text[end] === '{') {
                    // 找对应的 }
                    let braceDepth = 0;
                    while (end < text.length) {
                        if (text[end] === '{') braceDepth++;
                        else if (text[end] === '}') {
                            braceDepth--;
                            if (braceDepth === 0) {
                                end++;
                                break;
                            }
                        }
                        end++;
                    }
                }
                break;
            }
        } else if (ch === ';' && depth === 0) {
            end++;
            break;
        }
        end++;
    }

    return text.substring(start, end).replace(/\n/g, ' ').trim();
}

/**
 * 核心逻辑：流式生成 + 渐进式按行插入
 * 增强版：包含符号索引、调用链解析、调用点分析
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
    const targetUri = editor.document.uri;   // 保存目标文件 URI，后续插入不依赖 active editor
    const docLines = editor.document.getText().split('\n');  // 文档行快照，processLine 判断行内容用
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
            // 先检查是否有缓存（判断是否需要重建）
            const detectedRoot = findProjectRoot(filePath);
            const cacheExists = detectedRoot
                ? fs.existsSync(path.join(detectedRoot, '.learn-code-cache', 'symbols.json'))
                : false;
            progress.report({ message: cacheExists ? '📊 加载索引缓存...' : '📊 构建符号索引（首次）...' });
            channel.appendLine(cacheExists
                ? '📊 从缓存加载符号索引...\n'
                : '📊 构建符号索引（首次，耐心等待）...\n'
            );

            const symbolIndex = await buildSymbolIndex(fileUri);

            // 输出工程统计（让用户知道索引了多少内容）
            const fileCount = symbolIndex.files.size;
            let symbolCount = 0;
            for (const entries of symbolIndex.symbols.values()) {
                symbolCount += entries.length;
            }
            channel.appendLine(`  ✅ 工程索引完成`);
            channel.appendLine(`     📁 文件: ${fileCount} 个`);
            channel.appendLine(`     🏷️  符号: ${symbolCount} 个`);
            if (symbolIndex.rootPath) {
                channel.appendLine(`     📂 根目录: ${symbolIndex.rootPath}`);
            }
            channel.appendLine('');

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

            // ---- 查找调用点（核心差异化：详解实参来源）----
            progress.report({ message: '🔎 分析调用点...' });
            channel.appendLine('🔎 分析函数调用点...\n');

            const callSites = await findCallSites(selectedText, symbolIndex.rootPath || '', channel, filePath);
            if (callSites.length > 0) {
                channel.appendLine(`  ✅ 找到 ${callSites.length} 个调用点`);
                for (const site of callSites.slice(0, 3)) {
                    channel.appendLine(`     - ${site.file}:${site.line}  →  ${site.snippet.substring(0, 80)}`);
                }
            } else {
                channel.appendLine('  ⚠️ 未在工程内找到调用点（可能是入口函数或外部调用）');
            }

            // ---- 解析类链（类定义、实例化、继承）----
            progress.report({ message: '🔷 解析类链...' });
            channel.appendLine('🔷 解析类定义和实例化...\n');

            const classChain = await resolveClassChain(
                selectedText,
                symbolIndex,
                relFilePath,
                3000  // 最多 3000 tokens 给类上下文
            );

            if (classChain.classes.length > 0) {
                channel.appendLine(`  ✅ 找到 ${classChain.classes.length} 个相关类`);
                for (const cls of classChain.classes.slice(0, 5)) {
                    channel.appendLine(`     - ${cls.name} (${cls.file}:${cls.line})`);
                }
                if (classChain.classes.length > 5) {
                    channel.appendLine(`     ... 还有 ${classChain.classes.length - 5} 个`);
                }
            }
            if (classChain.unresolvedClasses.length > 0) {
                channel.appendLine(`  ⚠️ ${classChain.unresolvedClasses.length} 个类无法解析（可能是标准库/内置）`);
            }

            // ---- 查找类实例化点 ----
            progress.report({ message: '🔷 分析类实例化点...' });
            channel.appendLine('🔷 分析类实例化/继承点...\n');

            const classSites = await findClassSites(selectedText, symbolIndex.rootPath || '', channel, filePath);
            if (classSites.length > 0) {
                channel.appendLine(`  ✅ 找到 ${classSites.length} 个实例化/继承点`);
                for (const site of classSites.slice(0, 3)) {
                    channel.appendLine(`     - ${site.file}:${site.line}  →  ${site.snippet.substring(0, 80)}`);
                }
            } else {
                channel.appendLine('  ⚠️ 未在工程内找到实例化/继承点');
            }

            // ---- 构建深度上下文 Prompt ----
            progress.report({ message: '🤖 Ollama 正在生成（带深度上下文）...' });

            const language = detectLanguage(filePath);
            const projectContext = { rootPath: symbolIndex.rootPath || '', projectType, symbolIndex, summary };

            // ★ 声明合并代码和映射，供 buildDeepPrompt 使用（scan 块负责填充）
            const mergedToOriginalRel: number[] = [];
            let mergedCodeForPrompt = '';

            // ★ 统计信息提前输出（AI 调用之前）
            let lineOffset = 0;
            const insertedLines = new Set<number>();
            // ★ Bug Fix: 用 Set 追踪已跳过的绝对行号，替代会失效的 docLines 快照
            const skippedAbsLines = new Set<number>();

            // ★ 统计计数（基于代码选取，不依赖AI输出）
            let totalSelectedLines = 0;    // 总行数：选取的代码行总数（去重前）
            let invalidSkippedLines = 0;    // 无效行：被 shouldSkip 跳过的行数
            let validLines = 0;            // 有效行：总行数 - 无效行
            let insertedCount = 0;         // 实际成功插入的行数
            let multiLineAdjust = 0;       // 跨行调整：因跨行合并而减少的有效行数
            let multiLineCount = 0;       // 检测到的跨行语句数量

            // ★ 行号偏移修复：全局偏移量，跨块累积已插入的行数
            let globalInsertOffset = 0;

            // ★ 第一遍扫描：建立 skip 行号集合 + 跨行合并 + 确定总行数
            const multiLineAbsLines = new Set<number>(); // 跨行续行的绝对行号
            {
                const rawLines = selectedText.split('\n');
                totalSelectedLines = rawLines.length;

                let merging = false; // 正在跨行合并中

                for (let relLine = 1; relLine <= totalSelectedLines; relLine++) {
                    const absLine = startLine + (relLine - 1);
                    const codeLineText = (docLines[absLine] || '').trim();

                    // ---- 跳过检测 ----
                    const isBraceOnly = /^\}\s*(;)?(\s*\/\/.*)?$/.test(codeLineText);
                    const shouldSkipLine =
                        isBraceOnly ||
                        codeLineText === ');' ||
                        codeLineText.length === 0 ||
                        codeLineText.startsWith('#');

                    if (shouldSkipLine) {
                        skippedAbsLines.add(absLine);
                        merging = false;
                        continue;
                    }

                    // ---- 续行判断 ----
                    if (merging) {
                        mergedCodeForPrompt = mergedCodeForPrompt.trimEnd() + ' ' + codeLineText;
                        mergedToOriginalRel[mergedToOriginalRel.length - 1] = relLine;
                        channel.appendLine(`  ↪️  [行 ${relLine}] 已合并到上一行`);
                        merging = /[\(\[\<,]\s*$/.test(codeLineText);
                        continue;
                    }

                    // ---- 跨行首行检测 ----
                    const endsWithCont = /[\(\[\<,]\s*$/.test(codeLineText);
                    if (endsWithCont) {
                        multiLineAbsLines.add(absLine + 1);
                        merging = true;
                        multiLineCount++;
                        channel.appendLine(`  ↪️  [行 ${relLine}] 跨行语句开始`);
                    }

                    // 正常行或跨行首行：加入合并代码
                    if (mergedCodeForPrompt.length > 0) mergedCodeForPrompt += '\n';
                    mergedCodeForPrompt += codeLineText;
                    mergedToOriginalRel.push(relLine);
                }

                invalidSkippedLines = skippedAbsLines.size;
                // mergedToOriginalRel.length 即为有效行数
                validLines = mergedToOriginalRel.length;
                multiLineAdjust = multiLineCount;
            }

            // ★ 统计信息提前输出（AI 调用之前）
            channel.appendLine(`\n📊 代码选取统计：`);
            channel.appendLine(`   总行数: ${totalSelectedLines}  |  无效行(跳过): ${invalidSkippedLines}  |  跨行合并: -${multiLineAdjust}`);
            channel.appendLine(`   有效行: ${validLines}  |  将向 AI 分块处理（每块 15 行）`);
            channel.appendLine(``);

            // ★ 调试：打印代码行数，确认 AI 收到的是合并后行数还是 0
            const mergedLines = mergedCodeForPrompt.split('\n');
            channel.appendLine(`🧪 DEBUG: mergedCodeForPrompt 行数 = ${mergedLines.length}，内容预览 = ${JSON.stringify(mergedCodeForPrompt.substring(0, 80))}`);

            // ★ 分块处理：将有效行分成每块 15 行，逐块调用 Ollama
            const CHUNK_SIZE = 15;
            const totalChunks = Math.ceil(validLines / CHUNK_SIZE);
            const rawLines = selectedText.split('\n');  // 用于取代码原文

            for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
                const chunkStart = chunkIdx * CHUNK_SIZE;           // 0-based, 本块在 mergedLines 中的起始索引
                const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, validLines);  // exclusive
                const chunkLineCount = chunkEnd - chunkStart;      // 本块的行数

                channel.appendLine(`\n📦 开始处理第 ${chunkIdx + 1}/${totalChunks} 块（行 ${chunkStart + 1}-${chunkEnd}，共 ${chunkLineCount} 行）`);

                // ★ 构建本块的 mergedToOriginalRel 子映射
                const chunkValidIndices: number[] = [];
                for (let i = chunkStart; i < chunkEnd; i++) {
                    chunkValidIndices.push(i);
                }

                // ★ 提取本块涉及的调用点（筛选出 lineNum 落在本块范围内的）
                const chunkCallSites = callSites.filter(site => {
                    // site.line 是绝对行号（1-based），需要判断是否在本块范围内
                    // 本块的绝对行号范围 = startLine + chunkStart 到 startLine + chunkEnd - 1
                    const siteAbsLine = site.line;  // 1-based absolute
                    const chunkAbsStart = startLine + chunkStart;       // 1-based
                    const chunkAbsEnd = startLine + chunkEnd - 1;       // 1-based
                    return siteAbsLine >= chunkAbsStart && siteAbsLine <= chunkAbsEnd;
                });

                // ★ 构建本块的 skipLineNumbers（仅本块范围内的跳过行）
                const chunkSkipLineNumbers: number[] = [];
                for (let i = chunkStart; i < chunkEnd; i++) {
                    const absLine = startLine + (mergedToOriginalRel[i] - 1);
                    if (skippedAbsLines.has(absLine) || multiLineAbsLines.has(absLine)) {
                        // AI 看到的行号是相对行号（chunk 内从 1 开始）
                        chunkSkipLineNumbers.push(i - chunkStart + 1);
                    }
                }

                // ★ 取出本块的代码文本
                const chunkCode = mergedLines.slice(chunkStart, chunkEnd).join('\n');

                // ★ 构建深度上下文 Prompt（本块）
                const prompt = buildDeepPrompt({
                    selectedCode: chunkCode,
                    projectContext,
                    callChain,
                    callSites: chunkCallSites,
                    classChain,
                    classSites,
                    language,
                    filePath,
                    skipLineNumbers: chunkSkipLineNumbers,
                    lineOffset: chunkStart,  // 行号偏移，让 AI 看到正确的全局行号
                });

                // ★ 调试：保存第一块的 prompt
                if (chunkIdx === 0) {
                    const promptDebugPath = path.join(require('os').tmpdir(), 'learn-code-prompt-debug.txt');
                    require('fs').writeFileSync(promptDebugPath, prompt);
                    channel.appendLine(`🧪 DEBUG: 完整 prompt 已保存到 ${promptDebugPath}`);
                }

                // ★ 辅助函数：检查某绝对行是否应跳过
                function shouldSkip(absLine: number): boolean {
                    return skippedAbsLines.has(absLine);
                }

                // ★ 辅助函数：插入注释块
                // block.lineNum 在 processLine 中已直接设置为原文件绝对行号（0-based）
                async function insertPending(block: PendingBlock): Promise<boolean> {
                    const absLine = block.lineNum;

                    if (insertedLines.has(absLine)) return false;

                    const comment = block.content.trim();
                    if (!comment) return false;

                    try {
                        let targetDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === targetUri.toString());
                        if (!targetDoc) {
                            targetDoc = await vscode.workspace.openTextDocument(targetUri);
                        }

                        const lineCountBefore = targetDoc.lineCount;  // ★ 插入前行数

                        const targetRawLine = targetDoc.lineAt(absLine).text;
                        const codeIndent = targetRawLine.match(/^\s*/)?.[0] || '';

                        const formatted = formatCommentBlock(comment, codeIndent);
                        const insertText = formatted + '\n';

                        const edit = new vscode.WorkspaceEdit();
                        edit.insert(targetUri, new vscode.Position(absLine, 0), insertText);
                        const applied = await vscode.workspace.applyEdit(edit);
                        if (!applied) {
                            channel.appendLine(`  ⚠️ [行 ${absLine + 1}] 插入失败: applyEdit 返回 false`);
                            return false;
                        }

                        // ★ 用插入前后行数差，精确计算偏移量（不受换行符格式影响）
                        const targetDocAfter = await vscode.workspace.openTextDocument(targetUri);
                        const lineCountAfter = targetDocAfter.lineCount;
                        const actualInserted = lineCountAfter - lineCountBefore;

                        insertedLines.add(absLine);
                        insertedCount++;

                        globalInsertOffset += actualInserted;  // ★ 用准确值，非估算值

                        channel.appendLine(`  ✅ [行 ${absLine + 1}] 已插入 (实际插入 ${actualInserted} 行, globalInsertOffset 现为 ${globalInsertOffset})`);
                        return true;

                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        const friendly = msg.includes('closed editors')
                            ? '目标文件已关闭，请保持编辑器打开'
                            : msg;
                        channel.appendLine(`  ⚠️ [行 ${absLine + 1}] 插入失败: ${friendly}`);
                        return false;
                    }
                }

                // ★ 辅助函数：处理一行完整文本（本块版本）
                let lineBuffer = '';
                let pending: PendingBlock | null = null;
                let blockCount = 0; // 按出现顺序计数，与 AI 报的行号无关

                async function processLine(line: string): Promise<void> {
                    const trimmed = line.trim();
                    // 匹配任何分隔符行：--- 行 N --- 或 --- 块 N --- 或 ---
                    const isSep = /^\s*---\s*(?:行|块)?\s*\d*\s*---\s*$/.test(trimmed);

                    if (isSep) {
                        if (pending) {
                            await insertPending(pending);
                            pending = null;
                        }

                        if (blockCount < chunkLineCount) {
                            // ★ 实时计算 absLine，用【当前】globalInsertOffset（已包含所有前面插入的偏移）
                            const mergedRelLine = mergedToOriginalRel[chunkStart + blockCount];
                            const absLine = startLine + (mergedRelLine - 1) + globalInsertOffset;
                            channel.appendLine(`  🧪 DEBUG: blockCount=${blockCount}, mergedRelLine=${mergedRelLine}, globalInsertOffset=${globalInsertOffset}, 计算 absLine=${absLine} (1-based: ${absLine + 1})`);
                            pending = { lineNum: absLine, codeSnippet: '', content: '' };
                            blockCount++;
                        } else {
                            channel.appendLine(`  ⚠️ 多余的块分隔符，已忽略`);
                        }
                    } else {
                        if (pending) {
                            pending.content += line;
                        }
                    }
                }

                // ---- 流式读取 Ollama（本块）----
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
                        progress.report({ message: `🤖 已生成 ${charCount} 字符（第 ${chunkIdx + 1}/${totalChunks} 块）...` });
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
            }

            channel.appendLine(`\n✅ 注释生成完成！共插入 ${insertedCount} / ${validLines} 行。`);
            if (insertedCount < validLines) {
                channel.appendLine(`  ⚠️ 有 ${validLines - insertedCount} 个有效行未成功插入（指纹匹配失败或 AI 未生成）`);
            }
            progress.report({ message: `✅ 注释生成完成！` });

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
