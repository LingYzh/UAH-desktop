import { lineDiff } from '@lingyzh/ui/diff';

export function displayFilePath(path, directory) {
    const value = path.replaceAll('\\', '/');
    const base = directory?.replaceAll('\\', '/').replace(/\/$/, '');
    if (!base) return value;
    const windows = /^[a-z]:\//i.test(base) || base.startsWith('//');
    const matches = windows ? value.toLowerCase().startsWith(base.toLowerCase() + '/') : value.startsWith(base + '/');
    return matches ? value.slice(base.length + 1) : value;
}

export function changeCounts(before, after) {
    const diff = lineDiff(before, after);
    return { added: diff.omitted ? null : diff.added, removed: diff.omitted ? null : diff.removed };
}

export function fileChangeItem(artifact, directory) {
    return { id: artifact.id, path: displayFilePath(artifact.path, directory),
        status: artifact.oldContent === null ? 'A' : artifact.newContent === null ? 'D' : 'M',
        ...changeCounts(artifact.oldContent, artifact.newContent) };
}
