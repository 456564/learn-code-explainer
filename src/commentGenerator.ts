import { ProjectContext } from './projectScanner';
import { CallChainContext, ClassChainContext } from './callGraph';

/** 注释风格示例（来自用户提供的 CUDA 示例） */
const EXAMPLE_COMMENTS = `【示例风格参考】
\`\`\`c
#include <cstdint>
/*
 * 【作用】引入精确宽度的整数类型（如 uint8_t）。
 * 【原理】确保在不同操作系统和编译器下，该类型严格占用 1 个字节（8位）。
 * 【为什么这么做】避免隐式类型转换导致的跨平台内存对齐或截断 Bug。
 */

    int idx = blockIdx.x * blockDim.x + threadIdx.x;
/*
 * 【作用】计算当前线程在整个一维 Grid 中的全局唯一索引。
 * 【原理】GPU 采用 SIMT 架构，线程被组织为 Block 和 Grid。
 *         全局 ID = 所在 Block 的偏移量 + Block 内的偏移量。
 * 【为什么这么做】将三维图像数据展平为一维任务队列，这是处理连续内存最标准的做法。
 */

    if (idx >= total_pixels) return;
/*
 * 【作用】边界检查，防止越界访问显存。
 * 【原理】GPU 启动的线程总数通常是 256 的整数倍，大于实际像素数。
 *         多余的线程如果没有此判断，会产生非法内存访问（Segmentation Fault）。
 */

    float val = src[idx] / 255.0f;
/*
 * 【作用】将 [0, 255] 的整数值归一化到 [0.0, 1.0] 的浮点值。
 * 【原理】隐式将 uint8_t 提升为 float 后执行除法。
 * 【优化空间】浮点除法非常慢，吞吐量远低于乘法。
 * 【更好方法】改为乘以倒数：float val = src[idx] * 0.00392156862745098f;
 *             或者 float val = src[idx] * (1.0f / 255.0f);
 * 【为什么不用】依赖编译器的 -ffast-math 选项自动优化，或作者未关注此微优化。
 */
\`\`\``;

/**
 * 深度上下文 Prompt（增强版）
 * 包含被调用函数的完整定义，让模型能做原理级讲解
 */
export function buildDeepPrompt(params: {
    selectedCode: string;
    projectContext: ProjectContext;
    callChain: CallChainContext;
    callSites: Array<{
        file: string;
        line: number;
        snippet: string;
        args: string[];
    }>;
    /** 类上下文（定义、实例化、继承） */
    classChain?: ClassChainContext;
    /** 类实例化点 */
    classSites?: Array<{
        file: string;
        line: number;
        snippet: string;
        className: string;
        args: string[];
    }>;
    language: string;
    filePath: string;
    /** 不需要生成注释的行号（1-based），由调用方传入（含跨行续行） */
    skipLineNumbers?: number[];
    /** 行号偏移量（本批次起始行号-1），用于分块处理 */
    lineOffset?: number;
}): string {
    const {
        selectedCode,
        projectContext,
        callChain,
        callSites,
        classChain,
        classSites = [],
        language,
        filePath,
        skipLineNumbers = [],
        lineOffset = 0
    } = params;

    const lines = selectedCode.split('\n');
    const totalLines = lines.length;

    // 使用调用方传入的 skipLineNumbers（已在 extension.ts 中计算，含跨行续行）
    const skipLinesHint = skipLineNumbers.length > 0
        ? `\n⚠️ 以下行号严格禁止生成 "--- 行 N ---" 块（这些行不需要注释，生成了也会被丢弃）：行 ${skipLineNumbers.join(', ')}`
        : '';

    // 给选中代码加行号（分块时 lineOffset 偏移，让 AI 看到正确的全局行号）
    const numberedCode = lines
        .map((line, i) => `[${i + 1 + lineOffset}] ${line}`)
        .join('\n');

    // 构建被调用函数定义部分
    let definitionsSection = '';
    if (callChain.definitions.length > 0) {
        const defBlocks = callChain.definitions.map(def => {
            return `【${def.name}】(${def.kind}) - 位于 ${def.file}:${def.line}
\`\`\`${language}
${def.body}
\`\`\``;
        });
        definitionsSection = `
## 被调用函数定义（工程内相关代码）
${defBlocks.join('\n\n')}
`;
    }

    // 构建未解析的调用部分
    let unresolvedSection = '';
    if (callChain.unresolvedNames.length > 0) {
        unresolvedSection = `
## 无法解析的调用（工程外/内置函数）
${callChain.unresolvedNames.map(n => `- ${n}()`).join('\n')}
（可能是标准库函数、内置函数，或工程外定义的函数）
`;
    }

    // 构建调用点分析（核心差异化）
    let callSitesSection = '';
    if (callSites.length > 0) {
        const siteBlocks = callSites.map(site => {
            const argsDetail = site.args.length > 0
                ? '\n  实参拆解：\n' + site.args.map((arg, i) => `    参数${i + 1}: ${arg}`).join('\n')
                : '';
            return `【调用点】${site.file}:${site.line}
\`\`\`${language}
${site.snippet}
\`\`\`${argsDetail}`;
        });
        callSitesSection = `
## 工程内调用点分析（核心差异化）
${siteBlocks.join('\n\n')}
`;
    }

    // 构建类定义章节
    let classDefinitionsSection = '';
    if (classChain && classChain.classes.length > 0) {
        const classBlocks = classChain.classes.map(cls => {
            const baseInfo = cls.baseClasses.length > 0
                ? `\n  基类: ${cls.baseClasses.join(', ')}`
                : '\n  基类:（无）';
            return `【类 ${cls.name}】(${cls.kind}) - 位于 ${cls.file}:${cls.line}${baseInfo}
\`\`\`${language}
${cls.body}
\`\`\``;
        });
        classDefinitionsSection = `
## 类定义分析（工程内相关）
${classBlocks.join('\n\n')}
`;
    }

    // 构建类实例化章节
    let classInstantiationSection = '';
    if (classSites.length > 0) {
        const siteBlocks = classSites.map(site => {
            const argsDetail = site.args.length > 0
                ? '\n  实参拆解：\n' + site.args.map((arg, i) => `    参数${i + 1}: ${arg}`).join('\n')
                : '';
            return `【类实例化/继承】${site.file}:${site.line}
\`\`\`${language}
${site.snippet}
\`\`\`${argsDetail}`;
        });
        classInstantiationSection = `
## 类实例化/继承点分析
${siteBlocks.join('\n\n')}
`;
    }

    // 构建未解析的类章节
    let unresolvedClassesSection = '';
    if (classChain && classChain.unresolvedClasses.length > 0) {
        unresolvedClassesSection = `
## 无法解析的类（工程外/标准库）
${classChain.unresolvedClasses.map(n => `- ${n}`).join('\n')}
（可能是标准库类、内置类型，或工程外定义的类）
`;
    }

    return `你是一位追求极致的技术专家，正在为代码添加学习型详解注释。

## 任务目标
**核心目标：搞懂原理、吃透代码。**

你的注释不是简单的"这行代码干了什么"，而是：
1. 深入原理：为什么是这样实现的？
2. 依赖关系：这一行调用了哪些函数/变量？它们是怎么工作的？
3. 上下文关联：与工程里的其他代码有什么关联？
4. 优化空间：有没有更好的写法？时间和空间复杂度如何？
5. 限制条件：已知的边界情况、潜在 Bug、性能瓶颈是什么？

${definitionsSection}${unresolvedSection}${classDefinitionsSection}${unresolvedClassesSection}${classInstantiationSection}${callSitesSection}
## 项目架构摘要
${projectContext.summary}

## 带行号的选中代码（共 ${totalLines} 行）
\`\`\`${language}
${numberedCode}
\`\`\`

## 输出格式
**⚠️ 每个有意义的代码行必须对应一个独立的 "--- 行 N ---" 块，严禁合并！**
行号必须从 1 开始，且**最大不超过 ${totalLines}**（超出范围的行号均为无效输出）。${skipLinesHint}

**⚠️ 换行续行规则**：如果一行代码被换行符拆成多行（如函数调用实参换行），这仍然算"一行"，行号取【起始行号】。
例如：
\`\`\`c
YOLO::decodeOutputs(output_data, 80, 8400, objects,
                    scale, pad_w, pad_h,
                    frame.cols, frame.rows, 0.25f);
\`\`\`
只对应一个 "--- 行 N ---" 块，N = 起始行号。严禁为续行单独生成 "--- 行 N+1 ---" 块。

**⚠️ 以下行严格禁止生成 "--- 行 N ---" 块（生成了也会被丢弃，属于无效输出）：**
- #include / #define / #pragma 等预处理指令行
- 单独的 } 或 };（含行尾注释的也要跳过，如 } // end）
- 空行
- 仅含 ; 的空语句行

**只为"有意义的核心代码行"生成注释块**，用 "--- 行 N ---" 分隔（N 是原代码的行号）：

--- 行 1 ---
/*
 * 【作用】...
 * 【原理】...
 * 【传参详解】...（仅形参列表行有此项，如本行是函数签名 \`void foo(int x)\`）
 * 【依赖分析】...（涉及被调用函数时必填）
 * 【为什么这么做】...
 * 【优化空间】...（如有）
 * 【限制】...（如有）
 */

--- 行 2 ---
/*
 * 【作用】调用 YoloV8Detector::infer() 执行目标检测推理。
 * 【原理】将图像帧传入模型，获取归一化后的检测结果向量。
 * 【传参详解】（★★ 函数调用行必须逐个拆解每个实参）
 *   实参1: frame        → 图像帧（cv::Mat），来源于摄像头捕获的当前帧
 *   实参2: output_data → std::vector<float>&，由调用方在行1声明的输出容器（IN-OUT 参数）
 *   实参3: scale        → float，模型输入缩放系数（回传，用于还原检测框坐标）
 *   实参4: pad_w        → int，水平填充像素数（回传）
 *   实参5: pad_h        → int，垂直填充像素数（回传）
 * 【依赖分析】YoloV8Detector::infer()，定义于 src/yolo.cpp:45
 * 【为什么这么做】YoloV8 需要等比缩放+填充来适配网络输入尺寸，scale/pad 记录这一变换，以便将检测结果映射回原图坐标
 */

（#include、#define、空行、" } " 等行不生成注释块，跳过即可）

## 注释块规则
你**只能**为以下类型的行生成 "--- 行 N ---" 块：
1. 函数定义行（如 void foo(int x) 或 kernel<<<...>>>(...)）
2. 函数调用行（如 foo(a, b) 或 cudaMalloc(...)）
3. 变量声明/初始化行（如 int idx = ...; 或 float val = ...;）
4. 控制流语句（if/for/while/return/switch）
5. 有意义的表达式语句（赋值、计算等）

**⚠️ 严禁复制上一行的注释模板**：每个 "--- 行 N ---" 块的【作用】和【原理】必须与该行代码的实际语义完全匹配，禁止用上一行的解释文字敷衍。
示例：上一行是 int pixel_idx = idx / 3;（计算像素索引），
     下一行是 int c = idx % 3;（取余求通道号），
     两行的【作用】必须不同，不得都写"计算行和列索引"。

你**严禁**为以下行生成 "--- 行 N ---" 块（生成了也会被丢弃，属于无效输出）：
- #include / #define / #pragma 等**预处理指令行**（整行以 # 开头）
- 单独的 } 或 };（含行尾注释也一样跳过）
- **空行**（原代码行内容为空白）
- 仅含 ; 的空语句行

---
- 以 /* 开头，以 */ 结尾
- 每行前缀为 " * "（一个星号 + 一个空格）
- **【传参详解】的要求**（强制生成，不可省略，写"（无）"属于严重错误）：
  - **适用场景1——函数定义行（含构造函数定义）**，以下任意形式均属此类：
    - 普通函数：void foo(int a, float* b)
    - CUDA kernel: __global__ void kernel<<<...>>>(float* data)
    - C++ 构造函数：ClassName::ClassName(...) : initializer_list {
    - 示例：YoloV8Detector::YoloV8Detector(const std::string& engine_path, int input_size) : input_size_(input_size) {
    - **必须**根据下方"工程内调用点分析"章节，找到该函数被调用的实际位置，逐个讲解每个形参的实际用途。
    示例格式：
      形参1: src  → const uint8_t*，GPU 输入图像数据缓冲区（CUDA 设备内存指针），调用点传 d_src
      形参2: dst  → float*，GPU 输出图像数据缓冲区，调用点传 d_dst
      形参3: width → int，图像宽度（像素），调用点传 width
      形参4: height → int，图像高度（像素），调用点传 height
    - **⚠️ 绝对禁止写"（无）"**，函数定义行必定有参数，必须逐个列出并说明
    - 如果当前文件就是调用点（调用点 = 当前选中的函数），则基于变量声明推断形参含义
  - **适用场景2——函数调用行 / 构造函数调用（对象实例化）**，以下任意形式均属此类：
    - 普通成员函数调用：obj.method(a, b)
    - 普通函数调用：foo(a, b) 或 cudaMalloc(&ptr, size)
    - 对象实例化（调用构造函数）：ClassName obj(args) 或 Namespace::ClassName obj(args);
    - 示例1：detector.infer(frame, output_data, scale, pad_w, pad_h)
    - 示例2：YOLO::YoloV8Detector detector("../models/yolov8n_fp16.engine", 640);
    - **必须**逐个拆解每个实参，格式：
      实参1: frame        → cv::Mat，摄像头捕获的当前帧（来源：摄像头捕获）
      实参2: output_data  → std::vector<float>&，推理结果容器（由调用方在行1声明并传入）
      实参3: scale        → float，模型输入缩放系数（回传值，用于将检测框坐标还原到原图）
  - **适用场景3——局部变量初始化**（如 float val = src[idx] / 255.0f;）：解释变量含义（如"val：归一化后的像素浮点值"）
  - **禁止**：函数体内的纯计算行（如 int idx = x * y + z）**不写【传参详解】**，只写【作用】和【原理】
- **【依赖分析】的要求**：
  - 当注释的是**函数调用行**时（无论是被选代码内的调用还是对外调用），必须在【依赖分析】中写出：
    1. 被调用函数的**定义文件路径**（在"被调用函数定义"章节中查找）
    2. 被调用函数的**完整签名**
  - 示例：调用了 \`detector.infer(...)\` → 【依赖分析】YoloV8Detector::infer()，定义于 \`src/yolo.cpp:45\`；或"位于 \`include/detector.h\`"
  - 仅当该行没有任何函数调用时，才填"（无）"
- 【为什么这么做】：动机、权衡、为何选这个方案而非替代方案
- **不截断**：内容自然展开，原理讲透
- 如果某项无内容，写"（无）"或直接省略该项
- 结合【被调用函数定义】理解代码，说明本行是如何利用这些依赖工作的
- **当 callSitesSection 为空时**（未找到工程内调用点），【传参详解】改为基于函数签名中形参的类型和名称进行推演性讲解（如"第一个形参是 XX 类型，推测用于 XXX"），不要留空

## 更多注释示例（不同变量类型，必须参考）
--- 行 5 ---
/*
 * 【作用】通过取余运算求当前线程对应的通道索引（0=B, 1=G, 2=R）。
 * 【原理】CUDA 存储格式为行优先的 BGR 交错排列，每 3 个连续元素为 1 个像素。
 * 【为什么这么做】idx % 3 == 0/1/2 分别对应 B/G/R 三个通道。
 */

--- 行 6 ---
/*
 * 【作用】将 BGR 通道顺序反转为 RGB（适配深度学习模型输入要求）。
 * 【原理】BGR 的通道 0(B) 对应 RGB 的通道 2，通道 2(R) 对应通道 0，用 2 - c 完成映射。
 * 【为什么这么做】许多预训练模型（如 ImageNet）要求 RGB 输入，而 OpenCV 默认 BGR。
 */

--- 行 7 ---
/*
 * 【作用】将像素值从 [0, 255] 整数域归一化到 [0.0, 1.0] 浮点域。
 * 【原理】uint8_t 除以 255.0f（浮点常量），C++ 隐式将分子提升为 float 后执行除法。
 * 【优化空间】浮点除法延迟高，可改为乘法：src[idx] * (1.0f / 255.0f)。
 */

--- 行 8 ---
/*
 * 【作用】按 CHW（Channel-Height-Width）格式计算目标显存偏移量。
 * 【原理】深度学习中常用 CHW 布局：同一通道的 H×W 像素连续存储，偏移 = 通道号 × H × W + 像素索引。
 * 【为什么这么做】与 PyTorch / TensorRT 等框架的内存布局保持一致，避免额外的转置操作。
 */
 
请严格按照"--- 行 N ---"格式输出，不要输出原代码、不要用 markdown 代码块包裹。`;
}

/**
 * 原始的 Prompt（兼容旧逻辑）
 */
export function buildPrompt(params: {
    selectedCode: string;
    projectContext: ProjectContext;
    language: string;
    filePath: string;
}): string {
    const { selectedCode, projectContext, language, filePath } = params;

    // 给选中代码加行号
    const lines = selectedCode.split('\n');
    const numberedCode = lines
        .map((line, i) => `[${i + 1}] ${line}`)
        .join('\n');

    return `你是一位追求极致的技术专家，正在为代码添加学习型详解注释。

## 工程上下文
${projectContext.summary}

## 任务
我会给你带行号标记的代码，请你为**每一个非空行**生成对应的注释块。
**只输出注释块本身**，不要输出原代码，不要输出行号标记。

## 输出格式
为每个有效代码行输出一个注释块，用 "--- 行 N ---" 分隔（N 是原代码的行号）：

--- 行 1 ---
/*
 * 【作用】...
 * 【原理】...
 * 【为什么这么做】...
 * 【优化空间】...
 * 【限制】...
 */

--- 行 3 ---
/*
 * 【作用】...
 * ...
 */

## 注释块规则
- 以 /* 开头，以 */ 结尾
- 每行前缀为 " * "
- 【作用】：这一行代码做了什么（最简洁描述）
- 【原理】：底层原理、机制，可展开多行
- 【为什么这么做】：动机、权衡、为何不选替代方案
- 【优化空间】：有没有更好的写法？为何目前没采用？
- 【限制】：已知缺陷、边界条件、潜在 Bug
- **不截断**：内容自然展开，不限字数
- 如果某项无内容，写"（无）"
- 空行（原代码中的空行）不生成注释块

## 带行号的代码
\`\`\`${language}
${numberedCode}
\`\`\`

请严格按照"--- 行 N ---"格式输出，不要输出原代码、不要用 markdown 代码块包裹。`;
}
