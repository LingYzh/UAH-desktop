import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { AttachmentStore } from '../../src/main/attachment-store.js';
import {
    detectNativeAttachmentImageMime,
    NATIVE_ATTACHMENT_LIMITS,
    validateAttachments,
    type NativeAttachmentDescriptor,
} from '../../src/shared/attachments.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00]);

async function tempDirectory(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'uah-attachment-store-test-'));
}

async function cleanDirectory(path: string): Promise<void> {
    const target = resolve(path);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('uah-attachment-store-test-'));
    await rm(target, { recursive: true, force: true });
}

async function writeImage(path: string, bytes: Uint8Array): Promise<void> {
    await writeFile(path, bytes);
}

function descriptorId(descriptor: NativeAttachmentDescriptor): string {
    assert.match(descriptor.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    return descriptor.id;
}

test('prepares strict text snapshots, hides data from descriptors, resolves without consuming, and releases by id', async t => {
    const directory = await tempDirectory();
    t.after(() => cleanDirectory(directory));
    const path = join(directory, 'example.ts');
    await writeFile(path, 'const answer = 42;\n', 'utf8');
    const store = new AttachmentStore();
    const [descriptor] = await store.preparePaths([path]);
    assert.ok(descriptor);
    assert.equal(descriptor.kind, 'text');
    assert.equal(descriptor.name, 'example.ts');
    assert.equal(Object.hasOwn(descriptor, 'data'), false);
    assert.equal(Object.hasOwn(descriptor, 'path'), false);
    assert.equal(descriptor.size, Buffer.byteLength('const answer = 42;\n'));

    await writeFile(path, 'changed after selection', 'utf8');
    assert.equal(store.resolve([descriptorId(descriptor)])[0]?.data, 'const answer = 42;\n');
    assert.equal(store.resolve([descriptor.id])[0]?.data, 'const answer = 42;\n', 'resolve is retryable and does not consume the attachment');
    store.release([descriptor.id]);
    assert.throws(() => store.resolve([descriptor.id]), /不存在或已释放/);
});

test('decodes UTF-8 BOM and UTF-16 BOM text strictly without replacement or truncation', async t => {
    const directory = await tempDirectory();
    t.after(() => cleanDirectory(directory));
    const utf8Path = join(directory, 'utf8.md');
    await writeFile(utf8Path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('标题：猫\n', 'utf8')]));
    const lePath = join(directory, 'little.txt');
    await writeFile(lePath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('name = "猫"', 'utf16le')]));
    const bePath = join(directory, 'big.txt');
    const little = Buffer.from('value = 7', 'utf16le');
    const big = Buffer.from(little);
    for (let index = 0; index < big.length; index += 2) [big[index], big[index + 1]] = [big[index + 1]!, big[index]!];
    await writeFile(bePath, Buffer.concat([Buffer.from([0xfe, 0xff]), big]));
    const store = new AttachmentStore();
    const descriptors = await store.preparePaths([utf8Path, lePath, bePath]);
    assert.deepEqual(descriptors.map(item => store.resolve([item.id])[0]?.data), ['标题：猫\n', 'name = "猫"', 'value = 7']);
    assert.equal(store.resolve([descriptors[1]!.id])[0]?.size, Buffer.byteLength('name = "猫"'));

    const invalidUtf8 = join(directory, 'invalid.ts');
    await writeFile(invalidUtf8, Buffer.from([0xc3, 0x28]));
    await assert.rejects(store.preparePaths([invalidUtf8]), /严格 UTF-8/);
    const oddUtf16 = join(directory, 'odd.txt');
    await writeFile(oddUtf16, Buffer.from([0xff, 0xfe, 0x41]));
    await assert.rejects(store.preparePaths([oddUtf16]), /严格 UTF-8/);
});

test('snapshots supported images by magic and registers other files as path-only references', async t => {
    const directory = await tempDirectory();
    t.after(() => cleanDirectory(directory));
    const pngPath = join(directory, 'preview.PNG');
    const pdfPath = join(directory, 'manual.pdf');
    await writeImage(pngPath, PNG);
    await writeFile(pdfPath, '%PDF content that remains a path reference');
    const store = new AttachmentStore();
    const [image, file] = await store.preparePaths([pngPath, pdfPath]);
    assert.equal(image?.kind, 'image');
    assert.equal(image?.mimeType, 'image/png');
    assert.equal(Object.hasOwn(image ?? {}, 'data'), false);
    assert.equal(file?.kind, 'file');
    assert.equal(file?.path, resolve(pdfPath));
    assert.equal(file?.name, 'manual.pdf');
    assert.equal(Object.hasOwn(file ?? {}, 'data'), false);
    assert.equal(store.resolve([image!.id])[0]?.data, Buffer.from(PNG).toString('base64'));
    assert.deepEqual(store.resolve([file!.id])[0], { id: file!.id, name: 'manual.pdf', kind: 'file', size: Buffer.byteLength('%PDF content that remains a path reference'), path: resolve(pdfPath) });

    const pasted = store.prepareImage('clipboard-image.gif', GIF);
    assert.equal(pasted.kind, 'image');
    assert.equal(pasted.mimeType, 'image/gif');
    assert.equal(store.resolve([pasted.id])[0]?.data, Buffer.from(GIF).toString('base64'));
    assert.equal(detectNativeAttachmentImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
    assert.throws(() => store.prepareImage('bad.png', new Uint8Array([1, 2, 3])), /图片格式不受支持/);
});

test('rejects directories, symbolic links, malformed images, inconsistent data, and unknown fields', async t => {
    const directory = await tempDirectory();
    t.after(() => cleanDirectory(directory));
    const store = new AttachmentStore();
    await assert.rejects(store.preparePaths([directory]), /普通文件/);
    await assert.rejects(store.preparePaths(new Array(1) as string[]), /有效附件路径/);
    const target = join(directory, 'target.txt');
    const link = join(directory, 'linked.txt');
    await writeFile(target, 'safe text');
    let symlinkAvailable = true;
    try { await symlink(target, link, 'file'); }
    catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            symlinkAvailable = false;
        } else {
            throw error;
        }
    }
    if (symlinkAvailable) await assert.rejects(store.preparePaths([link]), /符号链接/);
    else t.diagnostic('This Windows host did not permit creating a file symlink; the path rejection remains implemented but was not exercised here.');

    const png64 = Buffer.from(PNG).toString('base64');
    const validImage = { id: randomUUID(), name: 'image.png', kind: 'image', size: PNG.length, mimeType: 'image/png', data: png64 };
    assert.throws(() => validateAttachments([{ ...validImage, mimeType: 'image/gif' }]), /魔数与 MIME/);
    assert.throws(() => validateAttachments([{ ...validImage, data: `${png64}!` }]), /Base64/);
    assert.throws(() => validateAttachments([{ ...validImage, size: PNG.length + 1 }]), /大小与数据不一致/);
    assert.throws(() => validateAttachments([{ ...validImage, path: target }]), /图片附件字段/);
    assert.throws(() => validateAttachments([{ id: randomUUID(), name: 'source.pdf', kind: 'file', size: 1, path: target, data: 'x' }]), /文件附件必须/);
    assert.throws(() => validateAttachments([{ ...validImage, unexpected: true }]), /未知字段/);
    assert.throws(() => validateAttachments(new Array(1)), /空项/);
    assert.throws(() => validateAttachments([{ ...validImage, data: 'A'.repeat(7_000_000) }]), /Base64/);
});

test('enforces per-file and per-batch limits atomically, plus registry count and total bytes', async t => {
    const directory = await tempDirectory();
    t.after(() => cleanDirectory(directory));
    const textA = join(directory, 'a.txt');
    const textB = join(directory, 'b.txt');
    const textC = join(directory, 'c.txt');
    await writeFile(textA, 'a'.repeat(NATIVE_ATTACHMENT_LIMITS.maxTextBytesPerFile));
    await writeFile(textB, 'b'.repeat(NATIVE_ATTACHMENT_LIMITS.maxTextBytesPerFile));
    await writeFile(textC, 'c');
    const store = new AttachmentStore();
    await assert.rejects(store.preparePaths([textA, textB, textC]), /512 KiB/);
    await assert.rejects(store.preparePaths([textA, textB, textC, textA, textB, textC, textA, textB, textC]), /最多添加 8 个/);
    const tooLargeText = join(directory, 'large.txt');
    await writeFile(tooLargeText, 'x'.repeat(NATIVE_ATTACHMENT_LIMITS.maxTextBytesPerFile + 1));
    await assert.rejects(store.preparePaths([tooLargeText]), /256 KiB/);

    const imageStore = new AttachmentStore();
    const largeImage = new Uint8Array(NATIVE_ATTACHMENT_LIMITS.maxImageBytesPerFile + 1);
    largeImage.set(PNG);
    assert.throws(() => imageStore.prepareImage('large.png', largeImage), /5 MiB/);
    const imageA = join(directory, 'a.png');
    const imageB = join(directory, 'b.png');
    const imageC = join(directory, 'c.png');
    const exactlyFiveMiB = new Uint8Array(NATIVE_ATTACHMENT_LIMITS.maxImageBytesPerFile);
    exactlyFiveMiB.set(PNG);
    await writeImage(imageA, exactlyFiveMiB);
    await writeImage(imageB, exactlyFiveMiB);
    await writeImage(imageC, PNG);
    await assert.rejects(imageStore.preparePaths([imageA, imageB, imageC]), /10 MiB/);
    const accepted = await imageStore.preparePaths([imageA, imageB]);
    assert.equal(accepted.length, 2);

    const countStore = new AttachmentStore();
    const tiny = () => countStore.prepareImage('tiny.png', PNG);
    for (let index = 0; index < NATIVE_ATTACHMENT_LIMITS.maxRegistryItems; index += 1) tiny();
    assert.throws(tiny, /32 项/);

    const capacityStore = new AttachmentStore();
    const largeFile = join(directory, 'capacity.pdf');
    const handle = await open(largeFile, 'w');
    const sparseFileSize = NATIVE_ATTACHMENT_LIMITS.maxRegistryBytes + 1;
    try { await handle.truncate(sparseFileSize); }
    finally { await handle.close(); }
    const capacityDescriptor = (await capacityStore.preparePaths([largeFile]))[0]!;
    assert.equal(capacityDescriptor.size, sparseFileSize);
    assert.deepEqual(capacityStore.resolve([capacityDescriptor.id])[0], { ...capacityDescriptor });
    const imageDescriptor = capacityStore.prepareImage('small.png', PNG);
    assert.equal(capacityStore.resolve([imageDescriptor.id])[0]?.kind, 'image', 'a path-only PDF larger than the payload cap must not consume in-memory attachment capacity');
});

test('rejects expired references in Chinese and releases expiry state on lookup', async () => {
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
        const store = new AttachmentStore();
        const descriptor = store.prepareImage('short-lived.png', PNG);
        assert.equal(store.resolve([descriptor.id])[0]?.kind, 'image');
        now += NATIVE_ATTACHMENT_LIMITS.ttlMs;
        assert.throws(() => store.resolve([descriptor.id]), /附件已过期，请重新添加/);
        assert.throws(() => store.resolve([descriptor.id]), /不存在或已释放/);
    } finally {
        Date.now = originalNow;
    }
});
