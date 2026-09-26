export interface RuntimeAdapter {
    readonly runtimeId: string;
    readonly modelId: string;
    stream(input: string): AsyncIterable<string>;
}

/** A deterministic local adapter for exercising the desktop approval and storage path. */
export class LocalVerificationAdapter implements RuntimeAdapter {
    readonly runtimeId = 'local-verification';
    readonly modelId = 'local-verification';

    async *stream(input: string): AsyncGenerator<string> {
        const response =
            '[local-verification]\n' +
            '本地验证适配器仅生成演示文本，不调用模型，也不读取凭据。\n\n' +
            input;
        const chunkSize = Math.max(8, Math.ceil(response.length / 64));
        let chunk = '';
        for (const character of response) {
            chunk += character;
            if (chunk.length >= chunkSize) {
                yield chunk;
                chunk = '';
            }
        }
        if (chunk.length > 0) {
            yield chunk;
        }
    }
}
