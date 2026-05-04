import { getConfig } from './settings';

export interface OllamaOptions {
    prompt: string;
    model?: string;
    timeout?: number;
}

/**
 * 调用 Ollama API（非流式，等待完整结果）
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
            temperature: 0.3,
            num_predict: 8192,
            num_ctx: 8192,
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
 * 流式调用 Ollama API，返回 AsyncGenerator 逐 token 产出
 */
export async function* callOllamaStream(
    options: OllamaOptions
): AsyncGenerator<string, void, unknown> {
    const config = getConfig();
    const endpoint = config.ollamaEndpoint;
    const model = options.model || config.model;
    const timeout = options.timeout || config.timeout;

    const body = {
        model,
        prompt: options.prompt,
        stream: true,
        options: {
            temperature: 0.3,
            num_predict: 8192,
            num_ctx: 8192,
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

        if (!response.body) {
            throw new Error('响应体为空，不支持流式读取');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const json = JSON.parse(trimmed);
                    if (json.response) {
                        yield json.response;
                    }
                    if (json.done) return;
                } catch {
                    // 忽略无法解析的行
                }
            }
        }

    } catch (err: unknown) {
        clearTimeout(timer);
        if (err instanceof Error && err.name === 'AbortError') {
            throw new Error(`Ollama 请求超时（${timeout / 1000}s）`);
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
