/**
 * 格式化注释块，包裹为 C 语言块注释风格。
 * 不截断，保持 AI 输出原样，只加星号前缀包裹。
 *
 * 输入：parse 后的纯注释文本
 * 输出：包裹后的完整注释块
 */
export function formatCommentBlock(commentText: string): string {
    if (!commentText || commentText.trim().length === 0) {
        return '';
    }

    // 统一换行符
    let text = commentText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // 确保每行都有星号前缀（如果没有就加上）
    const lines = text.split('\n');
    const formatted: string[] = [];

    for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed === '/*' || trimmed === '*/') {
            // 保留代码块标记行
            formatted.push(trimmed);
        } else if (trimmed.startsWith(' * ') || trimmed.startsWith(' *')) {
            // 已有正确前缀
            formatted.push(trimmed);
        } else if (trimmed.length === 0) {
            // 空行保留缩进
            formatted.push(' *');
        } else {
            // 没有星号前缀的行，加上前缀
            formatted.push(' * ' + trimmed);
        }
    }

    // 去掉首尾空行
    while (formatted.length > 0 && formatted[0].trim() === '') {
        formatted.shift();
    }
    while (formatted.length > 0 && formatted[formatted.length - 1].trim() === '') {
        formatted.pop();
    }

    // 组装最终输出
    const body = formatted.join('\n');
    return '/*\n' + body + '\n */';
}

/**
 * 将注释块按代码行号拆分。
 * 简单策略：遇到新的非星号开头的行，意味着上一个块结束。
 */
export function splitCommentBlocks(commentText: string): string[] {
    const blocks: string[] = [];
    const lines = commentText.split('\n');
    let currentBlock: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0 &&
            !trimmed.startsWith('*') &&
            !trimmed.startsWith('/*') &&
            !trimmed.startsWith('*/')) {
            if (currentBlock.length > 0) {
                blocks.push(currentBlock.join('\n'));
                currentBlock = [];
            }
        }
        currentBlock.push(line);
    }

    if (currentBlock.length > 0) {
        blocks.push(currentBlock.join('\n'));
    }

    return blocks;
}
