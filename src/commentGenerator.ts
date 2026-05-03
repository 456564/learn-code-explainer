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
 */
export function buildPrompt(params: {
    selectedCode: string;
    projectContext: ProjectContext;
    language: string;
    filePath: string;
}): string {
    const { selectedCode, projectContext, language, filePath } = params;

    return `你是一位追求极致的技术专家，正在为代码添加学习型详解注释。
在注释之前，请先理解整个工程的上下文，理解每一行代码在整体架构中的作用。

## 目标文件
${filePath}

## 工程上下文
${projectContext.summary}

## 注释格式规范
为每一行代码在下方添加学习型注释块，格式如下：

\`\`\`
代码行
/*
 * 【作用】...
 * 【原理】...
 * 【为什么这么做】...
 * 【优化空间】...
 * 【限制】...
 */
\`\`\`

规则：
- 【作用】：这一行代码做了什么，最简洁的描述
- 【原理】：底层原理、机制，必要时可展开多行说明
- 【为什么这么做】：动机、权衡、可读性与性能取舍，为何不选替代方案
- 【优化空间】：有没有更好的写法？如何改进？为何目前没采用？包括时间复杂度、空间复杂度、并行度等分析
- 【限制】：已知缺陷、边界条件、适用范围、潜在 Bug
- **不截断**：每条注释内容自然展开，不限字数，需要多少行就写多少行
- 多行内容用缩进对齐：
    第一层：  " *   - " （星号 + 3 空格 + 短横线 + 空格）
    第二层：  " *     " （星号 + 5 空格）
- 如果某项无内容，写"（无）"
- 空行不要生成注释
- 不要输出除了注释块以外的任何内容

## 示例
${EXAMPLE_COMMENTS}

请为以下代码生成注释：
\`\`\`${language}
${selectedCode}
\`\`\`
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
