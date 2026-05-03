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
 * 关键：让模型返回"原代码+注释"的完整版本，插件会直接替换选中代码
 */
export function buildPrompt(params: {
    selectedCode: string;
    projectContext: ProjectContext;
    language: string;
    filePath: string;
}): string {
    const { selectedCode, projectContext, language, filePath } = params;

    return `你是一位追求极致的技术专家，正在为代码添加学习型详解注释。

## 工程上下文
${projectContext.summary}

## 任务
请为下面的代码添加详细注释，**保持原代码不变**，在每行有效代码的下方添加注释块。

## 注释格式
在每行有效代码的下方添加注释块：
/* 注释内容 */

完整示例风格：
\`\`\`c
#include <cstdint>
/*
 * 【作用】引入精确宽度的整数类型
 * 【原理】确保类型严格占用 1 个字节
 */

    int idx = blockIdx.x * blockDim.x + threadIdx.x;
/*
 * 【作用】计算当前线程的全局唯一索引
 * 【原理】GPU SIMT 架构，全局 ID = Block 偏移 + 块内偏移
 */
\`\`\`

规则：
- **必须保留所有原代码**，只在其下方添加注释块
- 注释块格式：以 /* 开头，以 */ 结尾，每行前缀为 " * "
- 【作用】：这一行代码做了什么
- 【原理】：底层原理、机制
- 【为什么这么做】：动机、权衡、为何不选替代方案
- 【优化空间】：有没有更好的写法？
- 【限制】：已知缺陷、边界条件
- **不截断**：每条注释内容自然展开，不限字数
- 如果某项无内容，写"（无）"
- 空行保持原样，不添加注释
- 最后用 \`\`\`${language} 代码块包裹完整输出

## 需要添加注释的代码
\`\`\`${language}
${selectedCode}
\`\`\`

请只输出用代码块包裹的完整结果（原代码+注释），不要输出其他解释。
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
