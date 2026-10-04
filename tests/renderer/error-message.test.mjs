import test from 'node:test';
import assert from 'node:assert/strict';
import { clientError } from '../../src/shared/client-error.js';

const unknownErrorMessage = '操作未完成，请查看应用日志中的详细诊断。';

test('preserves trusted Chinese errors and unwraps Electron IPC errors', () => {
    const chinese = '端点已被其他操作修改。';

    assert.equal(clientError(chinese), chinese);
    assert.equal(clientError(new Error(chinese)), chinese);
    assert.equal(
        clientError(`Error invoking remote method 'endpoint:save': Error: ${chinese}`),
        chinese,
    );
});

test('maps common native, network, HTTP, protocol, cancellation, and conflict errors to Chinese', () => {
    assert.equal(clientError('Error: spawn git ENOENT'), '无法启动所需程序，请确认程序已安装且路径有效。');
    assert.equal(clientError('HTTP 429 Too Many Requests'), '请求过于频繁，请稍后重试。');
    assert.equal(clientError('Request failed with status code 401'), '认证失败，请检查 API Key 或访问凭据。');
    assert.equal(clientError('Unsupported protocol "ftp:"'), '服务协议不受支持，请检查端点地址和协议。');
    assert.equal(clientError('Invalid URL'), '服务地址格式无效，请检查端点设置。');
    assert.equal(clientError('API key is required'), '配置缺失或无效，请检查端点、模型和认证设置。');
    assert.equal(clientError('HTTP 503 Service Unavailable'), '服务暂时无法完成请求，请稍后重试。');
    assert.equal(clientError('connect ETIMEDOUT api.example.test:443'), '操作超时，请检查网络或服务状态后重试。');
    assert.equal(clientError('The operation was aborted'), '操作已取消。');
    assert.equal(
        clientError('Conflict: endpoint revision was changed by another operation'),
        '内容已被其他操作修改，请刷新后重试。',
    );
    assert.equal(
        clientError("EACCES: permission denied, open 'C:\\Users\\fixture\\settings.json'"),
        '无法访问所需文件或资源，请检查权限后重试。',
    );
});

test('does not expose unknown English diagnostics, fake keys, or Chinese paths', () => {
    const fakeKey = 'sk-fixture-not-a-real-key';
    const unknownEnglish = clientError(new Error(`Failed during a new transport operation with token ${fakeKey}`));
    assert.equal(unknownEnglish, unknownErrorMessage);
    assert.equal(unknownEnglish.includes(fakeKey), false);

    const pathOnlyChinese = clientError('Failed to read C:\\用户\\项目\\settings.json: ERR_UNKNOWN_FIXTURE');
    assert.equal(pathOnlyChinese, unknownErrorMessage);
    assert.equal(pathOnlyChinese.includes('用户'), false);

    const relativePathOnlyChinese = clientError('Failed to open 用户目录/config.yaml: ERR_UNKNOWN_FIXTURE');
    assert.equal(relativePathOnlyChinese, unknownErrorMessage);
});

test('uses retry text for empty errors and a safe generic message for unknown values', () => {
    assert.equal(clientError(null), '操作未完成，请重试。');
    assert.equal(clientError(undefined), '操作未完成，请重试。');
    assert.equal(clientError('  '), '操作未完成，请重试。');
    assert.equal(clientError(new Error('')), '操作未完成，请重试。');

    const unknownObject = {
        apiKey: 'sk-object-fixture-not-a-real-key',
        toJSON() {
            throw new Error('clientError must not serialize arbitrary objects');
        },
    };
    const result = clientError(unknownObject);
    assert.equal(result, unknownErrorMessage);
    assert.equal(result.includes(unknownObject.apiKey), false);
});
