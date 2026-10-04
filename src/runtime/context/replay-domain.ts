import { createHmac } from 'node:crypto';
import type { ApiConnection } from '../../shared/endpoints';
import { contextHash } from './projection';

export function replayDomain(connection: ApiConnection): string {
    return connection.id + ':' + createHmac('sha256', connection.apiKey).update(connection.baseUrl.replace(/\/+$/, '')).digest('hex');
}
export function contextRoute(connection: ApiConnection, modelId: string): string {
    return contextHash({ domain: replayDomain(connection), protocol: connection.protocol, modelId, serializer: 2 });
}
