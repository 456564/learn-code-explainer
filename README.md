# Learn Code Explainer

> 学习型代码详解注释插件 — 读取整个工程上下文，生成逐行原理级注释

## 功能

- **整工程感知**：注释前先扫描整个项目，理解代码在整体架构中的位置和作用
- **原理级注释**：每行代码生成【作用】【原理】【为什么这么做】【优化空间】【限制】五维度详解
- **多语言支持**：C/C++、Python、JavaScript、TypeScript、Go、Rust 等
- **完全本地**：基于 Ollama，无需 API Key，无数据外传

## 使用方法

### 前提条件

1. 安装 [Ollama](https://ollama.com/download)（Windows/macOS/Linux 均支持）
2. 下载推荐模型：
   ```bash
   # 代码专用（推荐）
   ollama run qwen2.5-coder:7b

   # 备选：通用模型
   ollama run codellama:7b
   ollama run llama3
   ```

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

## 配置项

在 VSCode 设置中搜索 `learnCodeExplainer`：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `ollamaEndpoint` | `http://localhost:11434` | Ollama API 地址 |
| `model` | `qwen2.5-coder:7b` | 使用的模型名称 |
| `timeout` | `120000` | 超时时间（毫秒） |
| `maxFiles` | `20` | 扫描工程时最多读取的文件数量 |
| `maxFileSize` | `51200` | 单个文件最大读取字节数 |

## 安装

```bash
# 1. 克隆或下载此项目到本地
# 2. 安装依赖
npm install

# 3. 编译 TypeScript
npm run compile

# 4. 打包为 .vsix
npm run package

# 5. 安装到 VSCode
#    在 VSCode 中：Ctrl+Shift+P → "Extensions: Install from VSIX"
#    选择生成的 learn-code-explainer-0.1.0.vsix
```

## 工程扫描说明

插件会自动向上查找项目根目录（寻找 `CMakeLists.txt`、`package.json`、`Cargo.toml` 等配置文件），然后扫描该目录下的所有源文件，提取：

- 源文件列表和大小
- 头文件 / 模块中的函数声明
- `import`、`#include`、`#define` 等依赖导入
- 文件内容片段（用于 AI 理解代码风格）

扫描结果作为上下文一起发送给 Ollama，确保注释能反映代码在整体架构中的作用。

## 常见问题

**Q: Ollama 连接失败？**
A: 确保 Ollama 已在运行（Windows 上启动 Ollama App 或命令行 `ollama serve`）

**Q: 注释生成很慢？**
A: 尝试使用量化版模型：`ollama run qwen2.5-coder:7b-instruct-q4_K_M`（体积更小，速度更快）

**Q: 注释格式不对？**
A: 确保选中的代码包含完整的语句（不是截断的行），Ollama 需要看到完整的上下文

## License

MIT
