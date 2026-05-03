import * as vscode from 'vscode';

/**
 * 从 VSCode settings 读取插件配置
 */
export function getConfig() {
    const config = vscode.workspace.getConfiguration('learnCodeExplainer');
    return {
        ollamaEndpoint: config.get<string>('ollamaEndpoint', 'http://localhost:11434'),
        model: config.get<string>('model', 'qwen2.5-coder:7b'),
        timeout: config.get<number>('timeout', 120000),
        maxFiles: config.get<number>('maxFiles', 20),
        maxFileSize: config.get<number>('maxFileSize', 51200),
    };
}
