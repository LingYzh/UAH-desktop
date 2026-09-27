import test from 'node:test';
import assert from 'node:assert/strict';
import { activityGroups } from '../../src/renderer/activity-groups.js';

test('consecutive execution groups preserve intervening reasoning and split at visible prose', () => {
    const items = ['tool', 'agent', 'text', 'tool', 'reasoning', 'tool', 'tool'].map((kind, id) => ({ id: String(id), kind }));
    const groups = activityGroups(items);
    assert.deepEqual(groups.map(group => group.items.map(item => item.id)), [['0', '1'], ['2'], ['3', '4', '5', '6']]);
    assert.deepEqual(groups.flatMap(group => group.items), items);
    assert.equal(activityGroups([...items.slice(0, 2), { id: 'later', kind: 'tool' }])[0].id, groups[0].id);
});
