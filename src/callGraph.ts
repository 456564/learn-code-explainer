import * as fs from 'fs';
import { SymbolIndex, SymbolEntry, getBuiltins } from './projectScanner';

/**
 * 解析函数/构造函数实参列表
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

/**
 * 类定义的完整信息
 */
export interface ClassAnalysis {
    name: string;
    kind: 'class';
    file: string;
    line: number;
    signature: string;          // 构造函数签名
    baseClasses: string[];     // 基类列表
    body: string;               // 完整类体
}

/**
 * 类实例化点
 */
export interface InstantiationSite {
    file: string;
    line: number;
    snippet: string;           // 完整实例化语句
    className: string;          // 被实例化的类名
    args: string[];             // 实参列表
}

/**
 * 类链上下文
 */
export interface ClassChainContext {
    classes: ClassAnalysis[];           // 类定义
    instantiations: InstantiationSite[]; // 实例化点
    unresolvedClasses: string[];         // 工程内找不到定义的类
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

// ============================================================
// 类链分析
// ============================================================

/**
 * 从选中代码提取类定义和实例化，并获取完整类体
 */
export async function resolveClassChain(
    selectedCode: string,
    index: SymbolIndex,
    filePath: string,
    maxTokens: number = 3000
): Promise<ClassChainContext> {
    // 1. 提取类实例化和类定义
    const { classNames, instantiationSites } = extractClassUsages(selectedCode);

    // 2. 查符号索引，获取类定义
    const classes: ClassAnalysis[] = [];
    const unresolvedClasses: string[] = [];

    for (const name of classNames) {
        const entries = index.symbols.get(name) || [];

        // 找最佳匹配
        let bestEntry: SymbolEntry | null = null;
        for (const entry of entries) {
            if (entry.kind === 'class' || entry.kind === 'struct') {
                if (!bestEntry || (entry.file === filePath && bestEntry.file !== filePath)) {
                    bestEntry = entry;
                }
            }
        }

        if (bestEntry) {
            const body = await getClassBody(bestEntry, index);
            if (body) {
                // 解析基类
                const baseClasses = extractBaseClasses(bestEntry.signature);

                classes.push({
                    name: bestEntry.name,
                    kind: 'class',
                    file: bestEntry.file,
                    line: bestEntry.line,
                    signature: bestEntry.signature,
                    baseClasses,
                    body,
                });
            }
        } else {
            unresolvedClasses.push(name);
        }
    }

    // 3. 裁剪到 token 上限
    const trimmedClasses = trimClassesToTokenLimit(classes, maxTokens);

    return {
        classes: trimmedClasses,
        instantiations: instantiationSites,
        unresolvedClasses,
    };
}

/**
 * 从代码中提取类使用（实例化和定义）
 */
function extractClassUsages(code: string): { classNames: string[]; instantiationSites: InstantiationSite[] } {
    const classNames = new Set<string>();
    const instantiationSites: InstantiationSite[] = [];

    // 匹配 new ClassName(...) 或 ClassName(...) (C++ 直接构造)
    // 也匹配 ClassName obj(args) 这种声明构造
    const lines = code.split('\n');
    let braceDepth = 0;
    let parenDepth = 0;
    let inString = false;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const lineNum = lineIdx + 1;

        // 匹配 new ClassName( 或 ClassName(（用于构造）
        // 排除关键字和已知的非类
        let i = 0;
        while (i < line.length) {
            const ch = line[i];

            // 处理字符串
            if (ch === '"' || ch === "'") {
                const quote = ch;
                i++;
                while (i < line.length && line[i] !== quote) {
                    if (line[i] === '\\') i++;
                    i++;
                }
                i++;
                continue;
            }

            // 跳过括号和花括号
            if (ch === '(') { parenDepth++; i++; continue; }
            if (ch === ')') { parenDepth--; i++; continue; }
            if (ch === '{') { braceDepth++; i++; continue; }
            if (ch === '}') { braceDepth--; i++; continue; }

            // 尝试匹配标识符
            if (/[A-Z]/.test(ch)) {
                let j = i;
                while (j < line.length && /[a-zA-Z0-9_]/.test(line[j])) {
                    j++;
                }
                const name = line.substring(i, j);

                // 检查后面是否跟 ( 或 <（模板）
                const afterParen = line.substring(j).match(/^\s*(\(|<)/);
                if (afterParen && parenDepth <= 1 && !KEYWORDS.has(name)) {
                    // 跳过 new 关键字后的标识符
                    const beforeName = line.substring(Math.max(0, i - 5), i).trim();
                    if (!beforeName.endsWith('new') && !beforeName.endsWith('delete')) {
                        classNames.add(name);

                        // 如果是 new 或直接构造，提取实例化信息
                        if (beforeName.endsWith('new') || (braceDepth === 0 && parenDepth === 1)) {
                            // 提取完整实例化语句
                            const snippet = extractInstantiationSnippet(line, i);
                            if (snippet) {
                                const argsStr = extractArgsFromInstantiation(line.substring(i));
                                const args = parseArguments(argsStr);

                                instantiationSites.push({
                                    file: '', // 由调用方填充
                                    line: lineNum,
                                    snippet,
                                    className: name,
                                    args,
                                });
                            }
                        }
                    }
                }

                i = j;
                continue;
            }

            i++;
        }
    }

    return {
        classNames: Array.from(classNames),
        instantiationSites,
    };
}

/**
 * 从实例化行提取完整语句
 */
function extractInstantiationSnippet(line: string, classNamePos: number): string {
    // 往前找语句开始
    let start = classNamePos;
    while (start > 0 && !/[;{\n=]/.test(line[start - 1])) {
        start--;
    }

    // 往后找到分号或括号平衡
    let end = classNamePos;
    let depth = 0;
    while (end < line.length) {
        const ch = line[end];
        if (ch === '(' || ch === '<') depth++;
        else if (ch === ')' || ch === '>') {
            if (depth === 0) break;
            depth--;
        } else if (ch === ';' && depth === 0) {
            end++;
            break;
        }
        end++;
    }

    return line.substring(start, end).trim();
}

/**
 * 提取实例化调用的参数字符串
 */
function extractArgsFromInstantiation(text: string): string {
    const parenMatch = text.match(/\([^)]*\)/);
    if (parenMatch) {
        return parenMatch[0].slice(1, -1);
    }
    return '';
}

/**
 * 提取类基类列表
 */
function extractBaseClasses(signature: string): string[] {
    const bases: string[] = [];
    const match = signature.match(/extends\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (match) {
        bases.push(match[1]);
    }
    // 也检查冒号后面的 C++ 继承
    const cppMatch = signature.match(/:\s*([^{]+)\{/);
    if (cppMatch) {
        const parts = cppMatch[1].split(',');
        for (const part of parts) {
            const nameMatch = part.match(/([A-Za-z_$][A-Za-z0-9_$]*)(?:::[A-Za-z_$][A-Za-z0-9_$]*)*$/);
            if (nameMatch) {
                bases.push(nameMatch[1]);
            }
        }
    }
    return bases;
}

/**
 * 获取类的完整定义（类体）
 */
async function getClassBody(entry: SymbolEntry, index: SymbolIndex): Promise<string> {
    const fileData = index.files.get(entry.file);
    if (!fileData) {
        try {
            if (fs.existsSync(entry.absFile)) {
                const content = fs.readFileSync(entry.absFile, 'utf-8');
                return extractClassBodyAtLine(content, entry);
            }
        } catch { /* ignore */ }
        return '';
    }

    return extractClassBodyAtLine(fileData.content, entry);
}

/**
 * 从文件内容中提取某行的类体
 */
function extractClassBodyAtLine(content: string, entry: SymbolEntry): string {
    const lines = content.split('\n');
    if (entry.line < 1 || entry.line > lines.length) {
        return '';
    }

    // 找类开始行
    let startLine = entry.line - 1;
    while (startLine > 0) {
        const prev = lines[startLine - 1].trim();
        if (prev === '' || prev.startsWith('//') || prev.startsWith('/*')) {
            startLine--;
        } else {
            break;
        }
    }

    // 找类体边界
    let braceCount = 0;
    let started = false;
    const bodyLines: string[] = [];

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

        if (started && braceCount === 0) {
            break;
        }

        if (i - startLine > 500) break; // 防止无限循环
    }

    return bodyLines.join('\n');
}

/**
 * 裁剪类定义列表到 token 上限
 */
function trimClassesToTokenLimit(classes: ClassAnalysis[], maxTokens: number): ClassAnalysis[] {
    let totalChars = classes.reduce((sum, c) => sum + c.body.length, 0);
    const limit = maxTokens * CHARS_PER_TOKEN;

    if (totalChars <= limit) {
        return classes;
    }

    // 按优先级排序：同文件 > 导出 > 其他
    const sorted = [...classes].sort((a, b) => {
        const aScore = (a.file.includes('main') ? 10 : 0);
        const bScore = (b.file.includes('main') ? 10 : 0);
        return bScore - aScore;
    });

    const result: ClassAnalysis[] = [];
    let used = 0;

    for (const cls of sorted) {
        if (used + cls.body.length <= limit) {
            result.push(cls);
            used += cls.body.length;
        } else {
            const remaining = limit - used;
            if (remaining > 100) {
                result.push({
                    ...cls,
                    body: cls.body.substring(0, remaining) + '\n    // ... (截断)',
                });
            }
            break;
        }
    }

    return result;
}
