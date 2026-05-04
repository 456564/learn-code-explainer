import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * 符号条目
 */
export interface SymbolEntry {
    name: string;           // 符号名
    kind: 'function' | 'struct' | 'class' | 'macro' | 'global' | 'typedef' | 'enum';
    file: string;           // 相对于根目录的路径
    absFile: string;       // 绝对路径
    line: number;          // 行号（1-based）
    signature: string;     // 签名（函数：返回类型+名+参数）
    isExported: boolean;    // 是否导出（其他文件可见）
}

/**
 * 文件级符号集合
 */
export interface FileSymbols {
    path: string;           // 相对路径
    absPath: string;        // 绝对路径
    symbols: SymbolEntry[];
    content: string;       // 完整文件内容
    mtime: number;         // 文件修改时间
}

/**
 * 符号索引
 */
export interface SymbolIndex {
    rootPath: string;       // 项目根目录
    files: Map<string, FileSymbols>;  // file → symbols
    symbols: Map<string, SymbolEntry[]>;  // name → entries（按名索引）
}

/**
 * 项目上下文（供 Prompt 使用）
 */
export interface ProjectContext {
    rootPath: string;
    projectType: string;
    symbolIndex: SymbolIndex;
    summary: string;        // 供 Prompt 使用的摘要
}

/** 重点关注的文件扩展名 */
const CODE_EXTS = new Set([
    '.c', '.cpp', '.h', '.hpp', '.py', '.js', '.ts',
    '.java', '.go', '.rs', '.rb', '.php', '.swift', '.kt',
    '.cs', '.m', '.mm', '.sh', '.bash', '.lua', '.zig'
]);

/** 配置文件（用于判断项目类型） */
const CONFIG_FILES = [
    'CMakeLists.txt', 'Makefile', 'package.json', 'Cargo.toml',
    'go.mod', 'requirements.txt', 'Pipfile', 'pyproject.toml',
    'build.gradle', 'pom.xml', 'docker-compose.yml', 'Dockerfile',
    'idf_component.yml', 'platformio.ini', 'Arduino.mk'
];

/** 缓存目录 */
const CACHE_DIR = '.learn-code-cache';
const CACHE_FILE = 'symbols.json';

/** 内置函数（提取调用时过滤） */
const C_BUILTINS = new Set([
    'printf', 'scanf', 'sprintf', 'sscanf', 'fprintf', 'fscanf',
    'malloc', 'calloc', 'realloc', 'free',
    'memcpy', 'memset', 'memmove', 'memcmp',
    'strlen', 'strcpy', 'strncpy', 'strcmp', 'strncmp', 'strcat', 'strncat',
    'atoi', 'atof', 'atol', 'itoa', 'sprintf',
    'sizeof', 'offsetof',
    'assert', 'abort', 'exit', 'return',
    'va_start', 'va_arg', 'va_end', 'va_copy',
    'pthread_create', 'pthread_mutex_lock', 'pthread_mutex_unlock',
    'esp_log_write', 'esp_log_level_set', 'ESP_LOGI', 'ESP_LOGE', 'ESP_LOGW', 'ESP_LOGD',
    'xPortGetTickRateHz', 'vTaskDelay', 'xTaskCreatePinnedToCore',
    'gpio_set_direction', 'gpio_get_level', 'gpio_set_level',
    'i2c_master_write', 'i2c_master_read',
    'vTaskDelay', 'esp_rom_delay_us',
]);

const PY_BUILTINS = new Set([
    'print', 'len', 'range', 'enumerate', 'zip', 'map', 'filter', 'reduce',
    'open', 'close', 'read', 'write', 'readline', 'readlines',
    'list', 'dict', 'set', 'tuple', 'str', 'int', 'float', 'bool',
    'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr',
    'import', 'from', 'as', 'def', 'class', 'return', 'yield',
    'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally',
    'with', 'pass', 'break', 'continue', 'raise', 'lambda',
    'super', 'self', '__init__', '__call__', '__str__', '__repr__',
]);

/**
 * 构建符号索引（带缓存）
 */
export async function buildSymbolIndex(targetUri: vscode.Uri): Promise<SymbolIndex> {
    const config = vscode.workspace.getConfiguration('learnCodeExplainer');
    const maxFiles = config.get<number>('maxFiles', 30);

    // 找项目根目录
    const rootPath = findProjectRoot(targetUri.fsPath);
    if (!rootPath) {
        return { rootPath: path.dirname(targetUri.fsPath), files: new Map(), symbols: new Map() };
    }

    // 尝试读取缓存
    const cachePath = path.join(rootPath, CACHE_DIR, CACHE_FILE);
    const cached = loadCache(cachePath, rootPath);
    if (cached) {
        // 缓存有效（loadCache 已验证文件存在），直接返回
        return cached;
    }

    // 构建新索引
    const index = await createSymbolIndex(rootPath, maxFiles);

    // 保存缓存
    saveCache(cachePath, index);

    return index;
}

/**
 * 创建符号索引
 */
async function createSymbolIndex(rootPath: string, maxFiles: number): Promise<SymbolIndex> {
    const files = new Map<string, FileSymbols>();
    const symbols = new Map<string, SymbolEntry[]>();

    // 收集源文件
    const sourceFiles = collectSourceFiles(rootPath, rootPath, []);
    const selectedFiles = sourceFiles.slice(0, maxFiles);

    for (const filePath of selectedFiles) {
        const relPath = path.relative(rootPath, filePath);
        const ext = path.extname(filePath).toLowerCase();

        if (!CODE_EXTS.has(ext)) continue;

        try {
            const stat = fs.statSync(filePath);
            const content = fs.readFileSync(filePath, 'utf-8');

            const fileSymbols: FileSymbols = {
                path: relPath,
                absPath: filePath,
                symbols: [],
                content,
                mtime: stat.mtimeMs,
            };

            // 提取各类符号
            if (['.cpp', '.hpp', '.cc', '.cxx', '.c', '.h', '.m', '.mm', '.java', '.cs', '.swift', '.kt', '.go', '.rs'].includes(ext)) {
                fileSymbols.symbols.push(...extractCFunctions(content, filePath, relPath));
                fileSymbols.symbols.push(...extractCStructs(content, filePath, relPath));
                fileSymbols.symbols.push(...extractCMacros(content, filePath, relPath));
                // 提取 C++ 类定义（class/struct，支持多行）
                fileSymbols.symbols.push(...extractCClasses(content, filePath, relPath));
            } else if (ext === '.py') {
                fileSymbols.symbols.push(...extractPyFunctions(content, filePath, relPath));
                fileSymbols.symbols.push(...extractPyClasses(content, filePath, relPath));
            } else if (['.js', '.ts', '.tsx'].includes(ext)) {
                fileSymbols.symbols.push(...extractJsFunctions(content, filePath, relPath));
                fileSymbols.symbols.push(...extractJsClasses(content, filePath, relPath));
            }

            // 加入索引
            files.set(relPath, fileSymbols);
            for (const sym of fileSymbols.symbols) {
                const existing = symbols.get(sym.name) || [];
                existing.push(sym);
                symbols.set(sym.name, existing);
            }
        } catch (err) {
            // 忽略读取失败的文件
        }
    }

    return { rootPath, files, symbols };
}

/** 递归收集源文件 */
function collectSourceFiles(dir: string, root: string, acc: string[]): string[] {
    if (acc.length >= 150) return acc;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === '.git' ||
                entry.name === 'build' || entry.name === 'dist' || entry.name === '__pycache__' ||
                entry.name.startsWith('.')) {
                continue;
            }
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                collectSourceFiles(fullPath, root, acc);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (CODE_EXTS.has(ext)) {
                    acc.push(fullPath);
                }
            }
        }
    } catch { /* ignore */ }
    return acc;
}

// ============================================================
// C/C++ 符号提取
// ============================================================

/** 提取 C 函数 */
function extractCFunctions(content: string, absFile: string, relFile: string): SymbolEntry[] {
    const results: SymbolEntry[] = [];
    const lines = content.split('\n');

    // 匹配函数定义：返回类型 函数名(参数) {
    // 支持：void func() { / static int func(int a) { / int *func() {
    const funcPattern = /(?:^|\n)([\s\t]*)(?:(?:static|inline|extern|__attribute__\s*\([^)]*\)\s*)?(?:const\s+)?(?:unsigned\s+|signed\s+)?(?:void|int|long|char|short|float|double|uint8_t|uint16_t|uint32_t|size_t|bool|auto|[\w_*]+?)\s*\*?\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)\s*\{/gm;

    let match;
    while ((match = funcPattern.exec(content)) !== null) {
        const indent = match[1];
        const retType = match[2].trim();
        const funcName = match[3].trim();
        const params = match[4].trim();

        // 计算行号
        const beforeMatch = content.substring(0, match.index);
        const lineNum = (beforeMatch.match(/\n/g) || []).length + 1;

        // 跳过 if/for/while/switch 语句里的内容
        if (funcName.startsWith('if_') || funcName.startsWith('for_') || funcName.startsWith('while_')) continue;
        if (['main'].includes(funcName)) {} // main 是特殊的

        const isExported = !indent.includes('static');

        results.push({
            name: funcName,
            kind: 'function',
            file: relFile,
            absFile,
            line: lineNum,
            signature: `${retType} ${funcName}(${params})`,
            isExported,
        });
    }

    return results;
}

/** 提取 C 结构体 */
function extractCStructs(content: string, absFile: string, relFile: string): SymbolEntry[] {
    const results: SymbolEntry[] = [];
    const lines = content.split('\n');

    // 匹配 struct/union/typedef struct
    // typedef struct { ... } name;
    // struct name { ... };
    const patterns = [
        /typedef\s+struct\s*(?:[a-zA-Z_][a-zA-Z0-9_]*)?\s*\{[^}]*\}[^;]*;/g,
        /struct\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\{[^}]*\};/g,
        /typedef\s+enum\s*([a-zA-Z_][a-zA-Z0-9_]*)/g,
        /enum\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\{/g,
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
            const lineNum = (content.substring(0, match.index).match(/\n/g) || []).length + 1;
            let name = '';

            if (match[1]) {
                name = match[1];
            } else {
                // typedef struct { ... } name; 提取末尾的名字
                const end = match[0].lastIndexOf('}');
                const after = match[0].substring(end + 1).trim();
                name = after.split(/[;]/)[0].trim();
            }

            if (name && name !== 'struct') {
                const kind: SymbolEntry['kind'] =
                    match[0].startsWith('enum') ? 'enum' :
                    match[0].startsWith('typedef struct') ? 'typedef' : 'struct';

                results.push({
                    name,
                    kind,
                    file: relFile,
                    absFile,
                    line: lineNum,
                    signature: `${kind} ${name}`,
                    isExported: true,
                });
            }
        }
    }

    return results;
}

/** 提取 C 宏定义 */
function extractCMacros(content: string, absFile: string, relFile: string): SymbolEntry[] {
    const results: SymbolEntry[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const match = line.match(/^#define\s+([A-Z_][A-Z0-9_]*)\s*(.*)$/);
        if (match) {
            results.push({
                name: match[1],
                kind: 'macro',
                file: relFile,
                absFile,
                line: i + 1,
                signature: `#define ${match[1]}`,
                isExported: true,
            });
        }
    }

    return results;
}

// ============================================================
// C++ 类符号提取（支持多行定义）
// ============================================================

/** 提取 C++ 类定义（class/struct，支持多行） */
function extractCClasses(content: string, absFile: string, relFile: string): SymbolEntry[] {
    const results: SymbolEntry[] = [];
    const lines = content.split('\n');

    // 匹配 class/struct 定义：class ClassName 或 struct StructName
    // 支持继承：class ClassName : public Base
    const classPattern = /(?:^|\n)([ \t]*)(?:export\s+)?(?:class|struct)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::[^{]*)?\{/gm;

    let match;
    while ((match = classPattern.exec(content)) !== null) {
        const indent = match[1];
        const className = match[2];
        const lineNum = (content.substring(0, match.index).match(/\n/g) || []).length + 1;

        // 跳过模板特化等
        if (className.includes('<')) continue;

        // 提取基类信息（在同一行）
        let baseClasses: string[] = [];
        const lineText = lines[lineNum - 1];
        const inheritMatch = lineText.match(/:\s*([^{]+)\{/);
        if (inheritMatch) {
            const bases = inheritMatch[1];
            // 提取基类名（去掉 public/protected/private 和命名空间）
            const baseMatches = bases.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)(?:::[a-zA-Z_][a-zA-Z0-9_]*)*/g);
            for (const m of baseMatches) {
                baseClasses.push(m[0]);
            }
        }

        // 提取构造函数签名（在同一行附近找）
        let ctorSignature = '';
        for (let i = lineNum; i < Math.min(lineNum + 20, lines.length); i++) {
            const candidate = lines[i];
            // 匹配构造函数：ClassName(...) 或 ClassName(...) : initializer_list {
            const ctorMatch = candidate.match(new RegExp(`${className}\\s*\\([^)]*\\)\\s*(?::[^;{]+)?\\s*\\{`));
            if (ctorMatch) {
                ctorSignature = ctorMatch[0].replace(/\\s+/g, ' ').trim();
                break;
            }
            // 如果遇到单独的 {，说明没有内联构造函数
            if (candidate.trim() === '{') {
                break;
            }
        }

        const isExported = !indent.includes('    '); // 有深缩进的可能是内部类

        const kind: SymbolEntry['kind'] = 'class';
        const signature = ctorSignature
            ? `${kind} ${className} { ... } // ${ctorSignature}`
            : `${kind} ${className}`;

        results.push({
            name: className,
            kind,
            file: relFile,
            absFile,
            line: lineNum,
            signature,
            isExported,
        });
    }

    return results;
}

// ============================================================
// Python 符号提取
// ============================================================

/** 提取 Python 函数 */
function extractPyFunctions(content: string, absFile: string, relFile: string): SymbolEntry[] {
    const results: SymbolEntry[] = [];
    const lines = content.split('\n');

    // 匹配 def func_name(...):
    const pattern = /(?:^|\n)([ \t]*)(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)\s*:/gm;

    let match;
    while ((match = pattern.exec(content)) !== null) {
        const indent = match[1];
        const funcName = match[2];
        const params = match[3];

        const lineNum = (content.substring(0, match.index).match(/\n/g) || []).length + 1;
        const isExported = !indent.includes('\t') && indent.length === 0;

        results.push({
            name: funcName,
            kind: 'function',
            file: relFile,
            absFile,
            line: lineNum,
            signature: `def ${funcName}(${params})`,
            isExported,
        });
    }

    return results;
}

/** 提取 Python 类 */
function extractPyClasses(content: string, absFile: string, relFile: string): SymbolEntry[] {
    const results: SymbolEntry[] = [];
    const lines = content.split('\n');

    // 匹配 class ClassName(...):
    const pattern = /(?:^|\n)([ \t]*)(?:async\s+)?class\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\([^)]*\))?\s*:/gm;

    let match;
    while ((match = pattern.exec(content)) !== null) {
        const className = match[2];
        const lineNum = (content.substring(0, match.index).match(/\n/g) || []).length + 1;

        results.push({
            name: className,
            kind: 'struct',  // 用 struct 近似表示 class
            file: relFile,
            absFile,
            line: lineNum,
            signature: `class ${className}`,
            isExported: true,
        });
    }

    return results;
}

// ============================================================
// JavaScript 符号提取
// ============================================================

/** 提取 JS 函数 */
function extractJsFunctions(content: string, absFile: string, relFile: string): SymbolEntry[] {
    const results: SymbolEntry[] = [];

    // 匹配 function funcName(...) {
    const funcPattern = /(?:^|\n)([ \t]*)(?:export\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(([^)]*)\)\s*\{/gm;
    let match;
    while ((match = funcPattern.exec(content)) !== null) {
        const lineNum = (content.substring(0, match.index).match(/\n/g) || []).length + 1;
        results.push({
            name: match[2],
            kind: 'function',
            file: relFile,
            absFile,
            line: lineNum,
            signature: `function ${match[2]}(${match[3]})`,
            isExported: match[1].includes('export'),
        });
    }

    // 匹配 const/let/var funcName = (...) => {
    const arrowPattern = /(?:^|\n)([ \t]*)(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>\s*\{/gm;
    while ((match = arrowPattern.exec(content)) !== null) {
        const lineNum = (content.substring(0, match.index).match(/\n/g) || []).length + 1;
        results.push({
            name: match[2],
            kind: 'function',
            file: relFile,
            absFile,
            line: lineNum,
            signature: `const ${match[2]} = (...) => {...}`,
            isExported: match[1].includes('export'),
        });
    }

    return results;
}

/** 提取 JS/TS 类定义 */
function extractJsClasses(content: string, absFile: string, relFile: string): SymbolEntry[] {
    const results: SymbolEntry[] = [];

    // 匹配 class ClassName 或 class ClassName extends BaseClass
    const classPattern = /(?:^|\n)([ \t]*)(?:export\s+)?class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:extends\s+([a-zA-Z_$][a-zA-Z0-9_$]*))?\s*\{/gm;

    let match;
    while ((match = classPattern.exec(content)) !== null) {
        const indent = match[1];
        const className = match[2];
        const baseClass = match[3] || '';
        const lineNum = (content.substring(0, match.index).match(/\n/g) || []).length + 1;

        const signature = baseClass
            ? `class ${className} extends ${baseClass}`
            : `class ${className}`;

        results.push({
            name: className,
            kind: 'class',
            file: relFile,
            absFile,
            line: lineNum,
            signature,
            isExported: match[1].includes('export'),
        });
    }

    return results;
}

// ============================================================
// 缓存管理
// ============================================================

interface CacheData {
    rootPath: string;
    timestamp: number;
    files: { [relPath: string]: { mtime: number; symbols: SymbolEntry[] } };
}

function loadCache(cachePath: string, currentRoot: string): SymbolIndex | null {
    try {
        if (!fs.existsSync(cachePath)) return null;

        const data: CacheData = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        if (data.rootPath !== currentRoot) return null;

        const files = new Map<string, FileSymbols>();
        const symbols = new Map<string, SymbolEntry[]>();

        for (const [relPath, fileData] of Object.entries(data.files)) {
            const absPath = path.join(currentRoot, relPath);
            if (!fs.existsSync(absPath)) continue;

            const stat = fs.statSync(absPath);
            const content = fs.readFileSync(absPath, 'utf-8');

            const fileSymbols: FileSymbols = {
                path: relPath,
                absPath,
                symbols: fileData.symbols,
                content,
                mtime: stat.mtimeMs,
            };

            files.set(relPath, fileSymbols);
            for (const sym of fileData.symbols) {
                const existing = symbols.get(sym.name) || [];
                existing.push(sym);
                symbols.set(sym.name, existing);
            }
        }

        return { rootPath: currentRoot, files, symbols };
    } catch {
        return null;
    }
}

function saveCache(cachePath: string, index: SymbolIndex): void {
    try {
        // 确保缓存目录存在
        const cacheDir = path.dirname(cachePath);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }

        const fileData: { [relPath: string]: { mtime: number; symbols: SymbolEntry[] } } = {};
        for (const [relPath, fileSym] of index.files) {
            fileData[relPath] = {
                mtime: fileSym.mtime,
                symbols: fileSym.symbols,
            };
        }

        const cache: CacheData = {
            rootPath: index.rootPath,
            timestamp: Date.now(),
            files: fileData,
        };

        fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    } catch { /* ignore */ }
}

function isCacheValid(index: SymbolIndex): boolean {
    // 简单验证：检查关键文件是否存在
    for (const [relPath] of index.files) {
        const absPath = path.join(index.rootPath, relPath);
        if (!fs.existsSync(absPath)) return false;
    }
    return true;
}

// ============================================================
// 辅助函数
// ============================================================

/** 向上查找项目根目录 */
export function findProjectRoot(filePath: string): string | null {
    let dir = path.dirname(filePath);
    const maxDepth = 10;
    for (let i = 0; i < maxDepth; i++) {
        for (const cfg of CONFIG_FILES) {
            if (fs.existsSync(path.join(dir, cfg))) {
                return dir;
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/** 根据配置文件判断项目类型 */
export function detectProjectType(rootPath: string): string {
    try {
        const files = fs.readdirSync(rootPath);
        if (files.includes('idf_component.yml') || files.includes('CMakeLists.txt')) {
            if (files.some(f => f.startsWith('sdkconfig'))) return 'ESP32 / ESP-IDF 嵌入式项目';
            return 'C/C++ CMake 项目';
        }
        if (files.includes('package.json')) {
            if (files.some(f => f.endsWith('.ts') || f.endsWith('.tsx'))) return 'TypeScript 项目';
            return 'Node.js / JavaScript 项目';
        }
        if (files.includes('Cargo.toml')) return 'Rust 项目';
        if (files.includes('go.mod')) return 'Go 项目';
        if (files.includes('requirements.txt') || files.includes('pyproject.toml')) return 'Python 项目';
        if (files.includes('Makefile')) return 'Make 项目';
    } catch { /* ignore */ }
    return '未知类型项目';
}

/** 构建供 Prompt 使用的工程摘要 */
export function buildSummary(projectType: string, index: SymbolIndex): string {
    const parts: string[] = [];

    parts.push(`【项目类型】${projectType}`);
    parts.push(`【项目根目录】${index.rootPath}`);
    parts.push(`【已索引文件数】${index.files.size}`);
    parts.push('');

    // 导出的函数列表
    const exportedFuncs: SymbolEntry[] = [];
    const structs: SymbolEntry[] = [];

    for (const sym of index.symbols.values()) {
        for (const s of sym) {
            if (s.isExported) {
                if (s.kind === 'function') exportedFuncs.push(s);
                if (s.kind === 'struct' || s.kind === 'typedef') structs.push(s);
            }
        }
    }

    if (exportedFuncs.length > 0) {
        parts.push('【导出的函数】');
        for (const f of exportedFuncs.slice(0, 30)) {
            parts.push(`  - ${f.signature} (${f.file}:${f.line})`);
        }
        parts.push('');
    }

    if (structs.length > 0) {
        parts.push('【数据结构】');
        for (const s of structs.slice(0, 20)) {
            parts.push(`  - ${s.signature} (${s.file}:${s.line})`);
        }
        parts.push('');
    }

    return parts.join('\n');
}

/** 获取符号的内置函数集合 */
export function getBuiltins(ext: string): Set<string> {
    if (['.c', '.cpp', '.h', '.hpp', '.m', '.mm'].includes(ext)) {
        return C_BUILTINS;
    }
    if (ext === '.py') {
        return PY_BUILTINS;
    }
    return new Set();
}
