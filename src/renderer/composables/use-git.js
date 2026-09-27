import { onBeforeUnmount, ref, toValue, watch } from 'vue';

/** A read-only directory query, scoped to the currently visible session. */
export function useGit(directory, scope, refreshSignal = () => '') {
    const result = ref(null);
    const busy = ref(false);
    const error = ref('');
    let generation = 0;
    let statusRequest = 0;
    async function query(kind, options = {}) {
        const epoch = generation;
        const requestedDirectory = toValue(directory) ?? null;
        if (!window.uah?.git) throw new Error('请重启更新后的桌面端以读取 Git。');
        const response = await window.uah.git({ directory: requestedDirectory, kind, ...options });
        return epoch === generation ? response : null;
    }
    async function refresh() {
        const request = ++statusRequest;
        busy.value = true;
        error.value = '';
        try {
            const response = await query('status');
            if (request === statusRequest && response) result.value = response;
        } catch (cause) {
            if (request === statusRequest) error.value = cause?.message || String(cause);
        } finally {
            if (request === statusRequest) busy.value = false;
        }
    }
    watch(() => [toValue(directory), toValue(scope)], () => {
        generation++;
        statusRequest++;
        result.value = null;
        error.value = '';
        refresh();
    }, { immediate: true, flush: 'sync' });
    watch(refreshSignal, () => refresh());
    onBeforeUnmount(() => { generation++; statusRequest++; });
    return { result, busy, error, refresh, query };
}
