# Learn Code Explainer

[![VS Code Version](https://img.shields.io/badge/VS%20Code-1.85.0+-blue.svg)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-源码-blue?logo=github)](https://github.com/456564/learn-code-explainer)
[![Gitee](https://img.shields.io/badge/Gitee-源码-red?logo=gitee)](https://gitee.com/dgfgdf/learn-code-explainer)

> 🚀 **学习型代码详解注释插件** — 读取整个工程上下文，生成逐行原理级注释，帮助你在阅读代码时真正"学会"而不是"看懂"。

## ✨ 功能特性

### 1. 整工程感知
注释前先扫描整个项目，理解代码在整体架构中的位置和作用。支持自动识别项目根目录（通过 `CMakeLists.txt`、`package.json`、`Cargo.toml`、`pom.xml` 等配置文件）。

### 2. 原理级注释
每行代码生成五维度详解：
- **【作用】** — 这行代码干了什么
- **【原理】** — 背后的技术原理（GPU 架构、内存模型、编译原理等）
- **【为什么这么做】** — 设计意图，为什么用这种方法而不是别的
- **【优化空间】** — 可能的改进方向
- **【限制】** — 边界条件、潜在问题

### 3. 调用链分析
- 自动追踪函数调用关系
- 识别调用点（call site）并分析传参
- 支持跨文件调用链解析
- **新增（v1.0.0）**：类定义提取和类调用链分析（C++/JavaScript/TypeScript）

### 4. 完全本地
基于 [Ollama](https://ollama.com)，无需 API Key，无数据外传，支持离线使用。

### 5. 多语言支持
| 语言 | 状态 | 特性 |
|------|------|------|
| C/C++ | ✅ 完整支持 | 函数定义、宏、结构体、类、CUDA kernel |
| Python | ✅ 完整支持 | 函数、类、装饰器 |
| JavaScript/TypeScript | ✅ 完整支持 | 函数、类、模块导入 |
| Go | ✅ 支持 | 函数、结构体 |
| Rust | ✅ 支持 | 函数、结构体、trait |

## 📦 安装

### 方式一：从 VSIX 安装（推荐）
1. 到 [Releases](https://github.com/456564/learn-code-explainer/releases) 页面下载最新 `.vsix` 文件
2. 在 VS Code 中：`Ctrl+Shift+P` → `Extensions: Install from VSIX...`
3. 选择下载的 `.vsix` 文件

### 方式二：从源码编译
```bash
# 1. 克隆仓库
git clone https://github.com/你的用户名/learn-code-explainer.git
cd learn-code-explainer

# 2. 安装依赖
npm install

# 3. 编译 TypeScript
npm run compile

# 4. 打包为 .vsix
npm run package

# 5. 安装生成的 .vsix 文件
```

### 前提条件
1. 安装 [Ollama](https://ollama.com/download)（Windows/macOS/Linux 均支持）
2. 下载推荐模型：
   ```bash
   # 代码专用（推荐）
   ollama pull qwen2.5-coder:7b

   # 备选：通用模型
   ollama pull codellama:7b
   ollama pull llama3
   ```

## 🚀 使用方法

### 触发方式
1. **快捷键**：`Ctrl+Shift+L`（选中代码后）
2. **右键菜单**：选中代码 → 右键 → "Learn Code: 详解选中代码"
3. **命令面板**：`Ctrl+Shift+P` → 搜索 "Learn Code: 详解选中代码"

### 注释格式示例
```c
int idx = blockIdx.x * blockDim.x + threadIdx.x;
/*
 * 【作用】计算当前线程在整个一维 Grid 中的全局唯一索引。
 * 【原理】GPU 采用 SIMT 架构，线程被组织为 Block 和 Grid。
 *         全局 ID = 所在 Block 的偏移量 + Block 内的偏移量。
 * 【为什么这么做】将三维图像数据展平为一维任务队列，这是处理连续内存最标准的做法。
 * 【优化空间】（无）
 * 【限制】（无）
 */
```

## ⚙️ 配置项

在 VS Code 设置中搜索 `learnCodeExplainer`：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `learnCodeExplainer.ollamaEndpoint` | `http://localhost:11434` | Ollama API 地址 |
| `learnCodeExplainer.model` | `qwen2.5-coder:7b` | 使用的模型名称 |
| `learnCodeExplainer.timeout` | `120000` | 超时时间（毫秒）|
| `learnCodeExplainer.maxFiles` | `20` | 扫描工程时最多读取的文件数量 |
| `learnCodeExplainer.maxFileSize` | `51200` | 单个文件最大读取字节数 |

## 🏗️ 技术架构

```
learn-code-explainer/
├── src/
│   ├── extension.ts          # 主入口，命令注册，逐行分析逻辑
│   ├── inlayProvider.ts     # InlayHint Provider（轻量单行显示）
│   ├── hoverProvider.ts     # Hover Provider（符号学习摘要）
│   ├── webviewPanel.ts      # 代码学习 Webview 面板
│   ├── callGraph.ts         # 调用链分析
│   ├── projectScanner.ts    # 符号索引构建
│   ├── commentGenerator.ts  # Prompt 构建
│   ├── ollama.ts           # Ollama 流式调用
│   ├── formatter.ts         # 注释格式化
│   └── types.ts            # 类型定义
├── out/                     # 编译输出
├── package.json             # 插件清单
└── README.md
```

## 📝 版本历史

### v1.0.0（2026-05-04）— 首个开源稳定版 🎉
- **新增**：类定义提取（`extractCClasses`、`extractJsClasses`）
- **新增**：类调用链分析（`resolveClassChain`、`findClassSites`）
- **新增**：Prompt 增强（类定义章节 + 类实例化章节）
- **修复**：行号偏移问题（`globalInsertOffset` 精确计算，用 `lineCountAfter - lineCountBefore` 替代估算）
- **修复**：实时计算 `absLine`（基于 `startLine + relLine + globalInsertOffset`）
- **优化**：流式插入注释，支持大文件分块处理（CHUNK_SIZE = 15）

### v0.4.16（2026-05-04）
- **修复**：TypeScript 编译错误（`SymbolEntry.kind` 添加 `'class'` 类型）
- **修复**：`parseArguments` 未定义（从 `extension.ts` 复制到 `callGraph.ts`）
- **优化**：`formatCommentBlock` 支持缩进对齐

### v0.4.15（2026-05-04）
- **修复**：行号偏移问题（初步修复，后在 v1.0.0 中完善）

### v0.4.14（2026-05-03）
- **修复**：AI 输出 `<function>...</function>` 包围导致块边界丢失
- **优化**：Prompt 加强对输出格式的限制

### v0.4.13（2026-05-03）
- **修复**：C 函数声明识别（`*` 可选，兼容 `int foo(int* p)` 和 `int foo(int *p)`）
- **修复**：`【传参详解】` 输出 `（无）`（Prompt 加粗禁止）
- **修复**：Pre-request 自动纠错

### v0.4.12（2026-05-03）
- **修复**：Typo "注解释" → "注释"

### v0.4.11（2026-05-03）
- **修复**：AI 仍为 `#include` 行生成注释块
- **新增**：`skipLinesHint` 动态计算跳过行号
- **优化**：Prompt 加强"允许/禁止"行类型白名单

### v0.4.10（2026-05-03）
- **修复**：`}` 行未被跳过（正则精确匹配失效）
- **修复**：`num_predict` 输出 token 上限过低（2048 → 4096）
- **优化**：Prompt 明确禁止为 `#include`/`}`/空行 生成注释块

### v0.4.9（2026-05-03）
- **修复**：`TextEditor#edit not possible on closed editors`
- **修复**：改用 `vscode.WorkspaceEdit`，不依赖编辑器实例

### v0.4.8（2026-05-02）
- **新增**：【传参详解】强制覆盖函数调用行

### v0.4.7（2026-05-02）
- **修复**：注释块缩进对齐
- **修复**：` * * 【作用】` 双星号重复问题

### v0.4.6（2026-05-02）
- **修复**：插入位置错误（插到行后方 → 插到行前方）
- **修复**：行丢失问题（`effectiveLines` 过滤太激进）

### v0.4.5（2026-05-01）
- **修复**：CUDA 调用点搜索失败（双 token 搜索策略）

### v0.4.0（2026-04-28）
- **初始版本**：支持 C/C++/Python/JS/TS 等语言
- 逐行注释：五维度详解
- 工程上下文感知：符号索引、调用链解析

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建你的特性分支（`git checkout -b feature/AmazingFeature`）
3. 提交你的更改（`git commit -m 'Add some AmazingFeature'`）
4. 推送到分支（`git push origin feature/AmazingFeature`）
5. 打开一个 Pull Request

### 开发调试
```bash
# 安装依赖
npm install

# 编译（监听模式）
npm run watch

# 按 F5 启动调试实例，在新窗口中测试插件
```

## 📄 开源协议

本项目采用 MIT 开源协议。详见 [LICENSE](LICENSE) 文件。

## 🙏 致谢

- [Ollama](https://ollama.com) — 本地大语言模型运行框架
- [qwen2.5-coder](https://ollama.com/library/qwen2.5-coder) — 代码专用大模型
- [VS Code](https://code.visualstudio.com/) — 优秀的代码编辑器

## 👤 作者

**作者**

- GitHub：[456564](https://github.com/456564)
- Gitee：[dgfgdf](https://gitee.com/dgfgdf)

---

⭐ 如果这个项目对你有帮助，请给它一个 Star！
