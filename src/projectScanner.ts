import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ProjectContext {
    /** 项目根目录 */
    rootPath: string;
    /** 项目类型推测（根据目录结构判断） */
    projectType: string;
    /** 所有扫描到的源文件列表 */
    files: FileInfo[];
    /** 汇总的结构化摘要，供 Prompt 使用 */
    summary: string;
}

export interface FileInfo {
    /** 相对于项目根的路径 */
    relPath: string;
    /** 文件扩展名 */
    ext: string;
    /** 文件大小（字节） */
    size: number;
    /** 提取的函数声明列表 */
    functions: string[];
    /** 提取的宏定义 / 全局变量 */
    declarations: string[];
    /** 文件内容摘要（截断后） */
    excerpt: string;
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

/**
 * 扫描目标文件所在的项目，提取结构和关键声明
 * 简化版：不做 AST，只用正则 + 文件内容解析
 */
export async function scanProject(targetUri: vscode.Uri): Promise<ProjectContext> {
    const config = vscode.workspace.getConfiguration('learnCodeExplainer');
    const maxFiles = config.get<number>('maxFiles', 20);
    const maxFileSize = config.get<number>('maxFileSize', 51200);

    // 找到项目根目录（向上找含配置文件的目录）
    const rootPath = findProjectRoot(targetUri.fsPath);
    if (!rootPath) {
        return {
            rootPath: path.dirname(targetUri.fsPath),
            projectType: '未知类型项目',
            files: [],
            summary: '（未能识别项目根目录）'
        };
    }

    // 收集所有源文件
    const allFiles = collectSourceFiles(rootPath, rootPath, []);
    const selectedFiles = allFiles.slice(0, maxFiles);

    // 读取每个文件的信息
    const files: FileInfo[] = [];
    for (const filePath of selectedFiles) {
        const info = await readFileInfo(filePath, rootPath, maxFileSize);
        if (info) {
            files.push(info);
        }
    }

    // 判断项目类型
    const projectType = detectProjectType(rootPath);

    // 生成工程摘要
    const summary = buildSummary(projectType, files, rootPath);

    return { rootPath, projectType, files, summary };
}

/** 向上查找项目根目录 */
function findProjectRoot(filePath: string): string | null {
    let dir = path.dirname(filePath);
    const maxDepth = 10;
    for (let i = 0; i < maxDepth; i++) {
        for (const cfg of CONFIG_FILES) {
            if (fs.existsSync(path.join(dir, cfg))) {
                return dir;
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break; // 已经到根了
        dir = parent;
    }
    return null;
}

/** 递归收集源文件 */
function collectSourceFiles(dir: string, root: string, acc: string[]): string[] {
    if (acc.length >= 100) return acc; // 最多 100 个
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === '.git' ||
                entry.name === 'build' || entry.name === 'dist' || entry.name === '__pycache__') {
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
    } catch {
        // 忽略权限错误
    }
    return acc;
}

/** 读取单个文件的信息 */
async function readFileInfo(
    filePath: string,
    rootPath: string,
    maxFileSize: number
): Promise<FileInfo | null> {
    try {
        const stat = fs.statSync(filePath);
        if (stat.size > maxFileSize) {
            // 超大文件只读摘要
            return {
                relPath: path.relative(rootPath, filePath),
                ext: path.extname(filePath).toLowerCase(),
                size: stat.size,
                functions: [],
                declarations: [],
                excerpt: `（文件过大 ${(stat.size / 1024).toFixed(0)}KB，仅读取前 ${(maxFileSize / 1024).toFixed(0)}KB）`
            };
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const relPath = path.relative(rootPath, filePath);
        const ext = path.extname(filePath).toLowerCase();

        // 提取函数声明（多种语言模式）
        const functions = extractFunctions(content, ext);
        // 提取宏定义 / 全局变量
        const declarations = extractDeclarations(content, ext);

        // 截取文件前几行作为摘要
        const lines = content.split('\n');
        const excerpt = lines.slice(0, 30).join('\n');

        return { relPath, ext, size: stat.size, functions, declarations, excerpt };
    } catch {
        return null;
    }
}

/** 提取函数声明（简化正则，不做完整 AST） */
function extractFunctions(content: string, ext: string): string[] {
    const results: string[] = [];

    if (['.c', '.cpp', '.h', '.hpp', '.js', '.ts', '.java', '.cs', '.m', '.mm', '.swift', '.kt', '.go', '.rs'].includes(ext)) {
        let m: RegExpExecArray | null;
        const re = /^[ \t]*(?:static\s+|inline\s+|extern\s+|virtual\s+|public\s+|private\s+|protected\s+|__attribute__\s*\([^)]*\)\s*)?((?:void|int|float|double|char|uint8_t|uint16_t|uint32_t|size_t|bool|auto|[\w_&*<>]+?))[ \t]+([\w_]+)[ \t]*\([^;{]*\)[ \t]*[;{]/gm;
        while ((m = re.exec(content)) !== null) {
            const ret = m[1].trim();
            const name = m[2].trim();
            if (!name.startsWith('if') && !name.startsWith('for') && !name.startsWith('while') && !name.startsWith('switch')) {
                results.push(`${ret} ${name}(...)`);
            }
        }
    } else if (ext === '.py') {
        let m: RegExpExecArray | null;
        const pyPattern = /^[ \t]*(?:async\s+)?def\s+([\w_]+)\s*\([^)]*\):/gm;
        while ((m = pyPattern.exec(content)) !== null) {
            results.push('def ' + m[1] + '(...)');
        }
    }

    return results.slice(0, 30); // 最多 30 个函数
}

/** 提取宏定义 / 全局变量 / import / include */
function extractDeclarations(content: string, ext: string): string[] {
    const results: string[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (ext === '.py') {
            if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
                results.push(trimmed);
            }
        } else if (['.c', '.cpp', '.h', '.hpp', '.m', '.mm'].includes(ext)) {
            if (trimmed.startsWith('#include ') || trimmed.startsWith('#define ') || trimmed.startsWith('typedef ')) {
                results.push(trimmed);
            }
        } else if (['.js', '.ts'].includes(ext)) {
            if (trimmed.startsWith('import ') || trimmed.startsWith('export ')) {
                results.push(trimmed);
            }
        }
    }

    return results.slice(0, 20);
}

/** 根据配置文件判断项目类型 */
function detectProjectType(rootPath: string): string {
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
    return '未知类型项目';
}

/** 构建供 Prompt 使用的工程摘要文本 */
function buildSummary(projectType: string, files: FileInfo[], rootPath: string): string {
    const parts: string[] = [];

    parts.push(`【项目类型】${projectType}`);
    parts.push(`【项目根目录】${rootPath}`);
    parts.push('');

    // 文件列表
    parts.push('【源文件列表】');
    for (const f of files) {
        const sizeLabel = f.size > 1024 ? `${(f.size / 1024).toFixed(0)}KB` : `${f.size}B`;
        parts.push(`  - ${f.relPath} (${sizeLabel})`);
    }
    parts.push('');

    // 头文件 / 模块接口
    const headerFiles = files.filter(f => ['.h', '.hpp', '.py', '.ts', '.go'].includes(f.ext));
    if (headerFiles.length > 0) {
        parts.push('【模块接口（函数声明）】');
        for (const f of headerFiles) {
            if (f.functions.length > 0) {
                parts.push(`  【${f.relPath}】`);
                for (const fn of f.functions.slice(0, 15)) {
                    parts.push(`    - ${fn}`);
                }
            }
        }
        parts.push('');
    }

    // 导入 / 包含
    const allImports = files.flatMap(f => f.declarations).filter(d => d.length > 0);
    if (allImports.length > 0) {
        parts.push('【依赖导入】');
        const seen = new Set<string>();
        for (const imp of allImports) {
            if (!seen.has(imp)) {
                seen.add(imp);
                parts.push(`  - ${imp}`);
            }
        }
        parts.push('');
    }

    // 文件内容片段（展示项目风格）
    parts.push('【文件内容片段（前 30 行）】');
    for (const f of files.slice(0, 3)) {
        if (f.excerpt.length > 0) {
            parts.push(`  === ${f.relPath} ===`);
            const excerptLines = f.excerpt.split('\n').slice(0, 10);
            for (const l of excerptLines) {
                parts.push(`  ${l}`);
            }
            parts.push('');
        }
    }

    return parts.join('\n');
}
