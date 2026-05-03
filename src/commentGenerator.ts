import { ProjectContext } from './projectScanner';

/** 注释风格示例（来自用户提供的 CUDA 示例，取最具代表性的几条） */
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
 * 更好方法】改为乘以倒数：float val = src[idx] * 0.00392156862745098f;
 *             或者 float val = src[idx] * (1.0f / 255.0f);
 * 【为什么不用】依赖编译器的 -ffast-math 选项自动优化，或作者未关注此微优化。
 */
\`\`\``;

/**
 * 构造发送给 Ollama 的完整 Prompt
 * 关键：让模型只返回注释块，每个块前加行号标记，插件负责插入到对应位置
 */
export function buildPrompt(params: {
    selectedCode: string;
    projectContext: ProjectContext;
    language: string;
    filePath: string;
}): string {
    const { selectedCode, projectContext, language, filePath } = params;

    // 给选中代码加行号，方便模型对应输出
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

请严格按照"--- 行 N ---"格式输出，不要输出原代码、不要用 markdown 代码块包裹。
`;
}

/**
 * 解析 Ollama 返回的注释块，提取纯注释文本（去掉 markdown 代码块包裹）
 */
export function parseCommentResponse(raw: string): string {
    // 去掉 markdown 代码块标记
    let cleaned = raw.trim();

    // 去掉首尾的 markdown 代码块标记
    cleaned = cleaned.replace(/^```[\w]*\n?/, '');
    cleaned = cleaned.replace(/\n?```$/, '');

    return cleaned.trim();
}
