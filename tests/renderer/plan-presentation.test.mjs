import assert from 'node:assert/strict';
import test from 'node:test';
import { currentPlanRun, planDocuments, planRunInput } from '../../src/renderer/plan-presentation.js';

test('task grouping keeps manual edit history and agent revisions together', () => {
    const v1 = { id: 'v1', version: 1, documentId: 'task', title: 'Task', content: 'one' };
    const v2 = { ...v1, id: 'v2', version: 2, content: 'two', status: 'revision-requested', history: [v1] };
    const v3 = { ...v1, id: 'v3', version: 3, content: 'three', status: 'proposed', title: 'Updated task' };
    const snapshot = { sessions: [{ id: 's', activePlanRunId: 'r2' }], runs: [
        { id: 'r1', sessionId: 's', plan: v2 }, { id: 'r2', sessionId: 's', plan: v3 },
        { id: 'clarification', sessionId: 's' }, { id: 'another-session', sessionId: 'other', plan: v1 },
    ] };
    const documents = planDocuments(snapshot, 's');
    assert.equal(documents.length, 1);
    assert.equal(documents[0].title, 'Updated task');
    assert.deepEqual(documents[0].versions.map(item => [item.id, item.runId, item.status]), [['v1', 'r1', 'archived'], ['v2', 'r1', 'revision-requested'], ['v3', 'r2', 'proposed']]);
    assert.equal(currentPlanRun(snapshot, 's').id, 'r2');
    snapshot.runs[1].history = { deleted: true };
    assert.equal(currentPlanRun(snapshot, 's'), undefined, 'deleting active plan must not reactivate an old plan');
});

test('legacy plan identities remain visible separately from unrelated tasks', () => {
    const snapshot = { sessions: [{ id: 's' }], runs: [
        { id: 'old', sessionId: 's', plan: { id: 'legacy', content: 'old' } },
        { id: 'new', sessionId: 's', plan: { id: 'new-id', documentId: 'new-doc', title: 'New task', version: 1 } },
    ] };
    assert.deepEqual(planDocuments(snapshot, 's').map(item => item.id), ['legacy', 'new-doc']);
    assert.equal(currentPlanRun(snapshot, 's').id, 'new');
});

test('approval and revision display the decision while retaining full model input', () => {
    const input = 'Approved plan with its complete Markdown body';
    const run = { id: 'implementation', sessionId: 's', input };
    const plan = { title: 'Task', version: 2, status: 'approved', executionRunId: run.id };
    const snapshot = { runs: [{ id: 'source', sessionId: 's', plan }, run] };
    assert.equal(planRunInput(run, snapshot), '已批准计划「Task · v2」，开始实施。');
    plan.status = 'revision-requested';
    plan.feedback = 'Add rollback steps';
    assert.equal(planRunInput(run, snapshot), '请修订计划「Task · v2」。\n\nAdd rollback steps');
    assert.equal(run.input, input, 'canonical input is unchanged');
    assert.equal(planRunInput({ ...run, sessionId: 'other' }, snapshot), input, 'do not pick another session’s plan');
});
