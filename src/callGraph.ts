import * as fs from 'fs';
import { SymbolIndex, SymbolEntry, getBuiltins } from './projectScanner';

/**
 * 函数调用的完整定义
 */
export interface FunctionDefinition {
    name: string;
    kind: SymbolEntry['kind'];
    file: string;
    line: number;
    signature: string;
    body: string;       // 完整函数体
}

/**
 * 调用链上下文
 */
export interface CallChainContext {
    definitions: FunctionDefinition[];
    calledNames: string[];      // 被调用的函数名
    unresolvedNames: string[];   // 工程内找不到定义的调用
}

/** 估计 token 数量（简单估算：每 4 字符 ≈ 1 token） */
const CHARS_PER_TOKEN = 4;

/**
 * 从选中代码提取函数调用，并获取完整定义
 */
export async function resolveCallChain(
    selectedCode: string,
    index: SymbolIndex,
    filePath: string,
    maxTokens: number = 4000
): Promise<CallChainContext> {
    // 1. 确定语言（根据扩展名）
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const builtins = getBuiltins(`.${ext}`);

    // 2. 提取函数调用名
    const calledNames = extractFunctionCalls(selectedCode, builtins);

    // 3. 查符号索引，获取定义
    const definitions: FunctionDefinition[] = [];
    const unresolvedNames: string[] = [];

    for (const name of calledNames) {
        const entries = index.symbols.get(name) || [];

        // 找最佳匹配：同文件优先，其次导出函数
        let bestEntry: SymbolEntry | null = null;
        for (const entry of entries) {
            if (entry.file === filePath) {
                bestEntry = entry;
                break;
            }
            if (entry.isExported && !bestEntry) {
                bestEntry = entry;
            }
            if (!bestEntry) {
                bestEntry = entry;
            }
        }

        if (bestEntry) {
            const body = await getDefinitionBody(bestEntry, index);
            if (body) {
                definitions.push({
                    name: bestEntry.name,
                    kind: bestEntry.kind,
                    file: bestEntry.file,
                    line: bestEntry.line,
                    signature: bestEntry.signature,
                    body,
                });
            }
        } else {
            unresolvedNames.push(name);
        }
    }

    // 4. 裁剪到 token 上限
    const trimmedDefinitions = trimToTokenLimit(definitions, maxTokens);

    return {
        definitions: trimmedDefinitions,
        calledNames,
        unresolvedNames,
    };
}

/**
 * 提取函数调用名
 */
export function extractFunctionCalls(code: string, builtins: Set<string> = new Set()): string[] {
    const calls = new Set<string>();

    // 匹配函数调用：func_name( 或 obj.method(
    // 排除：if/for/while/switch 后的条件部分
    const lines = code.split('\n');
    let braceDepth = 0;
    let inString = false;
    let parenDepth = 0;

    for (const line of lines) {
        // 简单状态机：跟踪括号和字符串
        let i = 0;
        while (i < line.length) {
            const ch = line[i];

            // 处理字符串
            if (ch === '"' || ch === "'") {
                const quote = ch;
                i++;
                while (i < line.length && line[i] !== quote) {
                    if (line[i] === '\\') i++; // 转义
                    i++;
                }
                i++;
                continue;
            }

            // 处理括号深度
            if (ch === '(') {
                parenDepth++;
                i++;
                continue;
            }
            if (ch === ')') {
                parenDepth--;
                i++;
                continue;
            }

            // 尝试匹配标识符
            if (/[a-zA-Z_]/.test(ch)) {
                let j = i;
                while (j < line.length && /[a-zA-Z0-9_]/.test(line[j])) {
                    j++;
                }
                const name = line.substring(i, j);

                // 遇到 '(' 且在适当括号深度时，是函数调用
                // 跳过关键字和已知的非函数
                const afterParen = line.substring(j).match(/^\s*\(/);
                if (afterParen && parenDepth === 1 && !KEYWORDS.has(name) && !builtins.has(name)) {
                    calls.add(name);
                }

                i = j;
                continue;
            }

            i++;
        }
    }

    return Array.from(calls);
}

/** Java/C/Python 关键字（不是函数调用） */
const KEYWORDS = new Set([
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
    'try', 'catch', 'finally', 'throw', 'throws',
    'return', 'break', 'continue', 'goto',
    'class', 'interface', 'extends', 'implements',
    'def', 'elif', 'lambda', 'yield',
    'assert', 'with', 'as', 'import', 'from',
    'public', 'private', 'protected', 'static', 'final',
    'const', 'let', 'var', 'function', 'async',
    'new', 'delete', 'typeof', 'instanceof',
    'in', 'of', 'is', 'not', 'and', 'or',
    'true', 'false', 'null', 'undefined', 'void',
    'sizeof', 'offsetof', 'alignof', '_Alignof',
]);

/**
 * 获取符号的完整定义（函数体）
 */
async function getDefinitionBody(entry: SymbolEntry, index: SymbolIndex): Promise<string> {
    const fileData = index.files.get(entry.file);
    if (!fileData) {
        // 文件不在索引中，尝试直接读取
        try {
            if (fs.existsSync(entry.absFile)) {
                const content = fs.readFileSync(entry.absFile, 'utf-8');
                return extractBodyAtLine(content, entry, index);
            }
        } catch { /* ignore */ }
        return '';
    }

    return extractBodyAtLine(fileData.content, entry, index);
}

/**
 * 从文件内容中提取某行的函数体
 */
function extractBodyAtLine(content: string, entry: SymbolEntry, index: SymbolIndex): string {
    const lines = content.split('\n');
    if (entry.line < 1 || entry.line > lines.length) {
        return '';
    }

    // 找函数开始行（可能有 static/inline 等修饰符）
    let startLine = entry.line - 1;
    while (startLine > 0) {
        const prev = lines[startLine - 1].trim();
        if (prev === '' || prev.startsWith('//') || prev.startsWith('/*') || prev.startsWith('*')) {
            startLine--;
        } else if (/^(?:static|inline|extern|const|__attribute__)\s/.test(prev)) {
            startLine--;
        } else {
            break;
        }
    }

    // 找函数体边界
    let braceCount = 0;
    let started = false;
    const bodyLines: string[] = [];
    let endLine = startLine;

    for (let i = startLine; i < lines.length; i++) {
        const line = lines[i];

        for (const ch of line) {
            if (ch === '{') {
                braceCount++;
                started = true;
            } else if (ch === '}') {
                braceCount--;
            }
        }

        if (started) {
            bodyLines.push(line);
        }

        // 函数结束（括号闭合）
        if (started && braceCount === 0) {
            endLine = i;
            break;
        }

        // 防止无限循环
        if (i - startLine > 200) break;
    }

    // Python：找函数体缩进
    if (['.py'].some(ext => entry.file.endsWith(ext))) {
        return extractPythonBody(lines, entry.line - 1);
    }

    return bodyLines.join('\n');
}

/**
 * 提取 Python 函数体
 */
function extractPythonBody(lines: string[], startLine: number): string {
    if (startLine < 0 || startLine >= lines.length) return '';

    // 找到函数的缩进级别
    const funcIndent = lines[startLine].match(/^(\s*)/)?.[1].length || 0;
    const funcLine = lines[startLine].trim();

    const bodyLines: string[] = [funcLine];
    let i = startLine + 1;

    while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '') {
            bodyLines.push(line);
            i++;
            continue;
        }

        // 检查缩进
        const indent = line.match(/^(\s*)/)?.[1].length || 0;

        // 如果缩进 <= 函数定义本身的缩进，且不是空行，函数结束
        if (indent <= funcIndent && !line.trim().startsWith('#')) {
            break;
        }

        bodyLines.push(line);
        i++;

        // 防止无限循环
        if (i - startLine > 200) break;
    }

    return bodyLines.join('\n');
}

/**
 * 裁剪定义列表到 token 上限
 */
function trimToTokenLimit(definitions: FunctionDefinition[], maxTokens: number): FunctionDefinition[] {
    let totalChars = definitions.reduce((sum, d) => sum + d.body.length, 0);
    const limit = maxTokens * CHARS_PER_TOKEN;

    if (totalChars <= limit) {
        return definitions;
    }

    // 按优先级排序：同文件 > 导出函数 > 其他
    const sorted = [...definitions].sort((a, b) => {
        const aScore = (a.file.includes('main') ? 10 : 0);
        const bScore = (b.file.includes('main') ? 10 : 0);
        return bScore - aScore;
    });

    const result: FunctionDefinition[] = [];
    let used = 0;

    for (const def of sorted) {
        if (used + def.body.length <= limit) {
            result.push(def);
            used += def.body.length;
        } else {
            // 截断函数体
            const remaining = limit - used;
            if (remaining > 100) {  // 至少保留 100 字符
                result.push({
                    ...def,
                    body: def.body.substring(0, remaining) + '\n    // ... (截断)',
                });
            }
            break;
        }
    }

    return result;
}
