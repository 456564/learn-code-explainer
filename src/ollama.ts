import { getConfig } from './settings';

export interface OllamaOptions {
    prompt: string;
    model?: string;
    timeout?: number;
    /** 设为 true 则流式返回（Generator），false 则等待完整结果 */
    stream?: boolean;
}

/**
 * 调用 Ollama API 生成注释
 * 优先流式，流式不可用时降级为普通调用
 */
export async function callOllama(options: OllamaOptions): Promise<string> {
    const config = getConfig();
    const endpoint = config.ollamaEndpoint;
    const model = options.model || config.model;
    const timeout = options.timeout || config.timeout;

    const body = {
        model,
        prompt: options.prompt,
        stream: false,
        options: {
            temperature: 0.3,        // 低温保证输出稳定
            num_predict: 2048,       // 最大生成 token 数
        }
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(`${endpoint}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Ollama 返回错误: HTTP ${response.status}\n${errorText}`);
        }

        const data = await response.json() as { response?: string; error?: string };
        if (data.error) {
            throw new Error(`Ollama 错误: ${data.error}`);
        }

        return data.response || '';

    } catch (err: unknown) {
        clearTimeout(timer);
        if (err instanceof Error && err.name === 'AbortError') {
            throw new Error(`Ollama 请求超时（${timeout / 1000}s），请检查 Ollama 是否运行或增加超时时间。`);
        }
        throw err;
    }
}

/**
 * 检查 Ollama 是否可用
 */
export async function checkOllamaHealth(): Promise<boolean> {
    try {
        const config = getConfig();
        const response = await fetch(`${config.ollamaEndpoint}/api/tags`, {
            method: 'GET',
            signal: AbortSignal.timeout(5000),
        });
        return response.ok;
    } catch {
        return false;
    }
}
