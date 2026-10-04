const EMPTY_ERROR_MESSAGE = '操作未完成，请重试。';
const UNKNOWN_ERROR_MESSAGE = '操作未完成，请查看应用日志中的详细诊断。';

const HTTP_MESSAGES = new Map([
    [400, '服务器拒绝了请求，请检查端点、模型和请求参数。'],
    [401, '认证失败，请检查 API Key 或访问凭据。'],
    [403, '服务拒绝访问，请检查账号权限。'],
    [404, '服务地址或模型不存在，请检查端点配置。'],
    [408, '服务响应超时，请稍后重试。'],
    [409, '目标状态已变化，请刷新后重试。'],
    [413, '请求内容过大，请减少内容后重试。'],
    [422, '请求参数未通过服务校验，请检查模型和参数设置。'],
    [429, '请求过于频繁，请稍后重试。'],
]);

function messageFrom(value) {
    if (value === null || value === undefined) return { empty: true };
    if (typeof value === 'string') return { empty: value.trim().length === 0, message: value.trim() };
    try {
        if (value instanceof Error && typeof value.message === 'string') {
            const message = value.message.trim();
            return { empty: message.length === 0, message };
        }
    } catch {
        return { empty: false };
    }
    return { empty: false };
}

function unwrapElectronMessage(message) {
    let result = message.trim();
    const remoteMethodPrefix = /^Error invoking remote method\s+(?:'[^']+'|"[^"]+"):\s*/i;
    const errorPrefix = /^(?:Error|TypeError|RangeError|ReferenceError|SyntaxError):\s*/i;
    while (remoteMethodPrefix.test(result) || errorPrefix.test(result)) {
        result = result.replace(remoteMethodPrefix, '').replace(errorPrefix, '').trim();
    }
    return result;
}

function hasChineseMessageText(message) {
    const textWithoutPaths = message
        .replace(/\b(?:https?|file):\/\/[^\s"'<>]+/gi, ' ')
        .replace(/(['"])(?:[A-Za-z]:[\\/]|\\\\|\/)[\s\S]*?\1/g, ' ')
        .replace(/\b[A-Za-z]:[\\/][^\r\n,;)}\]]*/g, ' ')
        .replace(/\\\\[^\r\n,;)}\]]*/g, ' ')
        .replace(/(?:^|[\s"'(])(?:\.\.?[\\/])?[\p{L}\p{N}_.-]+[\\/][\p{L}\p{N}_.-]+(?:[\\/][\p{L}\p{N}_.-]+)*/gu, ' ')
        .replace(/(?:^|\s)\/(?:[^\r\n,;)}\]]*)/g, ' ');
    const chineseCharacters = textWithoutPaths.match(/[\u3400-\u9fff]/g) ?? [];
    return chineseCharacters.length >= 2;
}

function httpStatus(message) {
    const match = /\bHTTP(?:\/\d+(?:\.\d+)?)?\s*[:#]?\s*([45]\d\d)\b/i.exec(message)
        ?? /\bstatus(?:\s+code)?\s*[:=]?\s*([45]\d\d)\b/i.exec(message);
    return match ? Number(match[1]) : null;
}

function knownEnglishMessage(message) {
    const lower = message.toLowerCase();

    if (/\b(?:aborterror|err_canceled|err_cancelled|cancelled|canceled|operation was aborted|request was aborted)\b/.test(lower)) {
        return '操作已取消。';
    }
    if (/\b(?:timeout|timed out|deadline exceeded|etimedout|esockettimedout|und_err_connect_timeout|err_timed_out)\b/.test(lower)) {
        return '操作超时，请检查网络或服务状态后重试。';
    }
    if (/\b(?:conflict|stale revision|revision mismatch|version conflict|modified by another operation|already modified)\b/.test(lower)) {
        return '内容已被其他操作修改，请刷新后重试。';
    }
    if (/\b(?:spawn|exec|fork)\b.*\b(?:enoent|not found)\b|\bcommand not found\b|\b(?:executable|program)\b.{0,40}\bnot found\b/i.test(message)) {
        return '无法启动所需程序，请确认程序已安装且路径有效。';
    }
    if (/\b(?:eaddrinuse|address already in use|port is already in use)\b/.test(lower)) {
        return '所需端口已被占用，请关闭占用程序后重试。';
    }
    if (/\b(?:eacces|eperm|permission denied|access denied|operation not permitted)\b/.test(lower)) {
        return '无法访问所需文件或资源，请检查权限后重试。';
    }
    if (/\b(?:enospc|no space left on device|disk is full)\b/.test(lower)) {
        return '磁盘空间不足，无法完成操作。';
    }
    if (/\b(?:enoent|no such file or directory|file not found|cannot find the file)\b/.test(lower)) {
        return '找不到所需文件或目录，请确认路径后重试。';
    }
    if (/\b(?:enotdir|not a directory|invalid path|path is invalid)\b/.test(lower)) {
        return '文件或目录路径无效，请检查路径后重试。';
    }
    if (/\b(?:eexist|file already exists|already exists)\b/.test(lower)) {
        return '目标文件或目录已存在，请检查后重试。';
    }

    const status = httpStatus(message);
    if (status !== null) {
        if (HTTP_MESSAGES.has(status)) return HTTP_MESSAGES.get(status);
        if (status >= 500) return '服务暂时无法完成请求，请稍后重试。';
        return '服务拒绝了请求，请检查端点配置和请求参数。';
    }

    if (/\b(?:unsupported protocol|protocol not supported|invalid protocol)\b/.test(lower)) {
        return '服务协议不受支持，请检查端点地址和协议。';
    }
    if (/\b(?:invalid url|url is invalid|malformed url|err_invalid_url)\b/.test(lower)) {
        return '服务地址格式无效，请检查端点设置。';
    }
    if (/\b(?:certificate|tls|ssl|secure connection)\b/.test(lower)) {
        return '安全连接失败，请检查服务证书和网络配置。';
    }
    if (/\b(?:enotfound|eai_again|getaddrinfo|name or service not known|dns lookup)\b/.test(lower)) {
        return '无法找到服务地址，请检查网络连接和端点地址。';
    }
    if (/\b(?:econnrefused|connection refused|actively refused)\b/.test(lower)) {
        return '服务拒绝了连接，请确认服务已启动且地址正确。';
    }
    if (/\b(?:econnreset|epipe|socket hang up|connection reset|connection closed unexpectedly)\b/.test(lower)) {
        return '网络连接中断，请检查网络或服务状态后重试。';
    }
    if (/\b(?:failed to fetch|networkerror|network error|err_network|fetch failed)\b/.test(lower)) {
        return '网络请求失败，请检查网络连接后重试。';
    }
    if (/\b(?:unauthorized|authentication failed|invalid api key|invalid token|missing credentials)\b/.test(lower)) {
        return '认证失败，请检查 API Key 或访问凭据。';
    }
    if (/\b(?:missing|required)\b.{0,40}\b(?:api key|token|credential|configuration|config|setting|endpoint|model)\b|\b(?:api key|token|credential|configuration|config|settings?|endpoint|model)\b.{0,40}\b(?:is\s+)?(?:missing|required|invalid|malformed|not configured)\b|\bmodel not selected\b|\b(?:invalid|malformed)\b.{0,30}\b(?:configuration|config|settings)\b/.test(lower)) {
        return '配置缺失或无效，请检查端点、模型和认证设置。';
    }
    if (/\b(?:invalid json|unexpected token|unexpected end of json|not valid json|invalid response format)\b/.test(lower)) {
        return '服务返回的数据格式无效，请检查端点协议和服务状态。';
    }
    if (/\b(?:non-zero exit|exit code [1-9]\d*|process exited|process failed|command failed)\b/.test(lower)) {
        return '外部程序未能完成操作，请查看应用日志中的详细诊断。';
    }
    return null;
}

export function clientError(value) {
    const source = messageFrom(value);
    if (source.empty) return EMPTY_ERROR_MESSAGE;
    if (source.message === undefined) return UNKNOWN_ERROR_MESSAGE;

    const message = unwrapElectronMessage(source.message);
    if (!message) return EMPTY_ERROR_MESSAGE;
    if (hasChineseMessageText(message)) return message;
    return knownEnglishMessage(message) ?? UNKNOWN_ERROR_MESSAGE;
}
