import type { ModelDetails } from '../shared/endpoints';

function object(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function positive(...values: unknown[]): number | undefined {
    return values.find(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1e9) as number | undefined;
}
function boolean(...values: unknown[]): boolean | undefined {
    return values.map(value => typeof value === 'boolean' ? value : object(value).supported).find(value => typeof value === 'boolean') as boolean | undefined;
}
function modalities(...values: unknown[]): ModelDetails['inputModalities'] {
    for (const value of values) {
        if (!Array.isArray(value)) continue;
        const known = [...new Set(value.filter(item => typeof item === 'string').map(item => item.toLowerCase()).filter(item => ['text', 'image', 'audio', 'video', 'file', 'pdf'].includes(item)))];
        if (value.length && !known.length) continue;
        return known as ModelDetails['inputModalities'];
    }
    return undefined;
}

/** Retains only reported, recognised capability fields; never infers from the model name. */
export function extractModelDetails(id: string, entry: unknown): ModelDetails {
    const source = object(entry);
    const capabilities = object(source.capabilities);
    const architecture = object(source.architecture);
    const limits = object(source.limits);
    const limit = object(source.limit);
    const input = object(capabilities.input);
    const nestedModalities = object(source.modalities);
    const provider = object(source.top_provider);
    const parameters = Array.isArray(source.supported_parameters) ? source.supported_parameters : [];
    const flags = Array.isArray(source.capabilities) ? source.capabilities : [];
    const inputModalities = modalities(architecture.input_modalities, source.input_modalities, source.inputModalities, source.supportedInputModalities, source.inputTypes, nestedModalities.input, capabilities.input_modalities);
    const outputModalities = modalities(source.output_modalities, source.outputModalities, architecture.output_modalities, nestedModalities.output, capabilities.output_modalities);
    const contextWindow = positive(limit.context, limit.context_window, limit.context_length, source.contextWindow, source.contextLength, source.inputTokenLimit, source.context_length, source.context_window, source.max_context_length, source.max_input_tokens, capabilities.context_window, limits.context_window, provider.context_length);
    const maxOutputTokens = positive(limit.output, source.outputTokenLimit, source.max_output_tokens, source.max_completion_tokens, source.max_tokens, capabilities.max_output_tokens, limits.max_output_tokens, provider.max_completion_tokens);
    const tools = boolean(source.supports_tools, source.supports_function_calling, capabilities.tools, capabilities.toolcall, capabilities.tool_call, capabilities.toolCall, capabilities.tool_calling, capabilities.function_calling, flags.includes('tools') || flags.includes('tool_calling') || parameters.includes('tools') || parameters.includes('tool_choice') ? true : undefined);
    const declared = (modality: NonNullable<ModelDetails['inputModalities']>[number]) => inputModalities === undefined ? undefined : inputModalities.includes(modality);
    const imageInput = boolean(capabilities.image_input, input.image, source.supports_vision, capabilities.vision, declared('image'), flags.includes('vision') ? true : undefined);
    const pdfInput = boolean(capabilities.pdf_input, input.pdf, inputModalities === undefined ? undefined : inputModalities.includes('pdf') || (Array.isArray(architecture.input_modalities) && architecture.input_modalities.includes('file')));
    const audioInput = boolean(capabilities.audio_input, input.audio, declared('audio'));
    const videoInput = boolean(capabilities.video_input, input.video, declared('video'));
    const vision = boolean(imageInput,source.supports_vision, capabilities.vision, flags.includes('vision') || inputModalities?.includes('image') ? true : undefined);
    const reasoning = boolean(source.supports_reasoning, capabilities.reasoning, capabilities.thinking, flags.includes('reasoning') || flags.includes('thinking') || parameters.includes('reasoning') || parameters.includes('reasoning_effort') ? true : undefined);
    const streaming = boolean(source.supports_streaming, capabilities.streaming, flags.includes('streaming') ? true : undefined);
    return {
        id,
        ...(imageInput === undefined ? {} : { imageInput }),
        ...(pdfInput === undefined ? {} : { pdfInput }),
        ...(audioInput === undefined ? {} : { audioInput }),
        ...(videoInput === undefined ? {} : { videoInput }),
        ...(inputModalities ? { inputModalities } : {}),
        ...(outputModalities ? { outputModalities } : {}),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...(tools === undefined ? {} : { tools }),
        ...(vision === undefined ? {} : { vision }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(streaming === undefined ? {} : { streaming }),
    };
}
