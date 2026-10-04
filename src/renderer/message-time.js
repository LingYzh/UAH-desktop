const formatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

// Stored instants are shown in the device's local timezone, never as elapsed time.
export function messageTime(value) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '时间未记录';
    return formatter.format(new Date(value));
}
