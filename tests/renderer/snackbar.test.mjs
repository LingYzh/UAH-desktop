import test from 'node:test';
import assert from 'node:assert/strict';
import { snackbar, snackbarState } from '@lingyzh/ui/snackbar';

test('snackbar global configuration, bounded stacks, sticky notices and timer cleanup', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    snackbar.clear();
    snackbar.configure({ position: 'top-right', duration: 1000, tone: 'success' });
    const first = snackbar.show('first');
    assert.equal(snackbarState.notices.value[0].position, 'top-right');
    snackbar.show('second');
    snackbar.show('third');
    snackbar.show('fourth');
    assert.equal(snackbarState.notices.value.length, 3);
    assert.equal(snackbarState.notices.value.some((item) => item.id === first), false);
    const sticky = snackbar.show('sticky', { duration: 0, position: 'bottom-left' });
    context.mock.timers.tick(1000);
    assert.deepEqual(snackbarState.notices.value.map((item) => item.id), [sticky]);
    snackbar.dismiss(sticky);
    context.mock.timers.tick(10000);
    assert.equal(snackbarState.notices.value.length, 0);
    snackbar.configure({ position: 'bottom-center', duration: 6000, tone: 'info' });
});

test('snackbar pointer and keyboard pauses independently preserve the remaining duration', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const id = snackbar.show('pause both', { duration: 1000 });
    context.mock.timers.tick(300);
    snackbarState.pause(id, 'pointer');
    snackbarState.pause(id, 'focus');
    context.mock.timers.tick(5000);
    snackbarState.resume(id, 'pointer');
    context.mock.timers.tick(5000);
    assert.equal(snackbarState.notices.value.length, 1);
    snackbarState.resume(id, 'focus');
    context.mock.timers.tick(699);
    assert.equal(snackbarState.notices.value.length, 1);
    context.mock.timers.tick(1);
    assert.equal(snackbarState.notices.value.length, 0);
});
