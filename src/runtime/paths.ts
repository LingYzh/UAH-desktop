import {
    closeSync,
    fstatSync,
    fsyncSync,
    lstatSync,
    openSync,
    realpathSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

function pathKey(value: string): string {
    const normalized = resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function assertNoReparseComponents(absolutePath: string): void {
    const absolute = resolve(absolutePath);
    const root = parse(absolute).root;
    const components = relative(root, absolute).split(sep).filter(Boolean);
    let current = root;

    for (let index = 0; index < components.length; index += 1) {
        current = join(current, components[index]);
        const info = lstatSync(current);
        if (info.isSymbolicLink()) {
            throw new Error(`Directory path crosses a symbolic link or reparse point: ${current}`);
        }
        if (index < components.length - 1 && !info.isDirectory()) {
            throw new Error(`Directory path component is not a directory: ${current}`);
        }
    }
}

export function canonicalizeDirectory(input: string): string {
    if (typeof input !== 'string' || input.trim().length === 0 || input.length > 32_000) {
        throw new Error('A valid directory path is required');
    }

    const absolute = resolve(input);
    assertNoReparseComponents(absolute);
    const real = realpathSync.native(absolute);
    assertNoReparseComponents(real);
    if (!statSync(real).isDirectory()) {
        throw new Error(`Selected path is not a directory: ${input}`);
    }
    return resolve(real);
}

export function sameDirectory(left: string, right: string): boolean {
    return pathKey(left) === pathKey(right);
}

export function directoryLeaseKey(directory: string): string {
    return pathKey(directory);
}

export function expectedOutputPath(directory: string, runId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
        throw new Error('Invalid run identifier for output filename');
    }
    return resolve(directory, `uah-check-${runId}.txt`);
}

export interface CreatedFile {
    path: string;
    dev: number;
    ino: number;
}

function removeIfSameFile(path: string, expected: { dev: number; ino: number }): void {
    try {
        const current = lstatSync(path);
        if (current.isFile() && current.dev === expected.dev && current.ino === expected.ino) {
            unlinkSync(path);
        }
    } catch {
        // A missing path means there is nothing left to clean up.
    }
}

/** Creates a new output file without following or overwriting an existing target. */
export function writeNewFileExclusive(
    directory: string,
    runId: string,
    content: string,
): CreatedFile {
    const canonical = canonicalizeDirectory(directory);
    if (!sameDirectory(canonical, directory)) {
        throw new Error('The selected directory no longer resolves to its approved location');
    }

    const outputPath = expectedOutputPath(canonical, runId);
    if (!sameDirectory(dirname(outputPath), canonical) || !isAbsolute(outputPath)) {
        throw new Error('Output path escaped the selected directory');
    }

    let descriptor: number | undefined;
    let ownedFile: { dev: number; ino: number } | undefined;
    try {
        assertNoReparseComponents(canonical);
        descriptor = openSync(outputPath, 'wx', 0o600);
        const info = fstatSync(descriptor);
        ownedFile = { dev: info.dev, ino: info.ino };
        writeFileSync(descriptor, content, 'utf8');
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;

        const latestCanonical = canonicalizeDirectory(directory);
        if (!sameDirectory(latestCanonical, canonical)) {
            throw new Error('The selected directory changed while writing the output file');
        }
        const created = lstatSync(outputPath);
        if (!created.isFile() || created.isSymbolicLink()) {
            throw new Error('The new output path is not a regular file');
        }
        if (!ownedFile) {
            throw new Error('Could not verify the created output file');
        }
        return { path: outputPath, dev: ownedFile.dev, ino: ownedFile.ino };
    } catch (error) {
        if (descriptor !== undefined) {
            try {
                const info = fstatSync(descriptor);
                ownedFile = { dev: info.dev, ino: info.ino };
            } catch {
                // Keep the best file identity captured after creation.
            }
            try {
                closeSync(descriptor);
            } catch {
                // Preserve the original write error.
            }
        }
        if (ownedFile) {
            removeIfSameFile(outputPath, ownedFile);
        }
        throw error;
    }
}

export function removeCreatedFile(createdFile: CreatedFile): void {
    removeIfSameFile(createdFile.path, createdFile);
}
