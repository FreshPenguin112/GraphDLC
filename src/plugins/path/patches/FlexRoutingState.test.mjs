import assert from 'node:assert/strict';
import test from 'node:test';
import { FlexRoutingState } from './FlexRoutingState.ts';

test('toggling a mark marks and unmarks an empty cell', () => {
    const state = new FlexRoutingState();
    assert.equal(state.toggleMark({ x: 4, y: 7 }), true);
    assert.deepEqual(state.getMarks(), [{ x: 4, y: 7 }]);
    assert.equal(state.toggleMark({ x: 4, y: 7 }), false);
    assert.deepEqual(state.getMarks(), []);
});

test('select all selects every mark and a second press clears it', () => {
    const state = new FlexRoutingState();
    state.toggleMark({ x: 1, y: 1 });
    state.toggleMark({ x: 2, y: 1 });

    state.selectAllMarks();
    assert.deepEqual(state.getSelectedMarks(), [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
    ]);

    state.selectAllMarks();
    assert.equal(state.hasSelection(), false);
});

test('select all with no marks selects nothing', () => {
    const state = new FlexRoutingState();
    state.selectAllMarks();
    assert.equal(state.hasSelection(), false);
});

test('unmarking a selected mark removes it from the selection', () => {
    const state = new FlexRoutingState();
    state.toggleMark({ x: 3, y: 3 });
    state.toggleMark({ x: 4, y: 3 });
    state.selectAllMarks();

    state.toggleMark({ x: 3, y: 3 });

    assert.deepEqual(state.getSelectedMarks(), [{ x: 4, y: 3 }]);
    assert.equal(state.isSelected({ x: 3, y: 3 }), false);
});

test('marks may overlay occupied cells without any arrow state', () => {
    const state = new FlexRoutingState();
    state.toggleMark({ x: 9, y: 9 });
    assert.equal(state.hasMark({ x: 9, y: 9 }), true);
    assert.equal(state.hasMark({ x: 9, y: 10 }), false);
});

test('rotation and flip belong to the selection and reset when it clears', () => {
    const state = new FlexRoutingState();
    state.toggleMark({ x: 0, y: 0 });
    state.selectAllMarks();

    state.setRotation(3);
    state.toggleFlipped();
    assert.deepEqual(state.getTransform(), { rotation: 3, flipped: true });

    state.clearSelection();
    assert.deepEqual(state.getTransform(), { rotation: 0, flipped: false });
});

test('selection key changes with the selected set', () => {
    const state = new FlexRoutingState();
    state.toggleMark({ x: 1, y: 0 });
    state.toggleMark({ x: 0, y: 0 });
    state.selectAllMarks();
    const first = state.getSelectionKey();

    state.toggleMark({ x: 1, y: 0 });
    assert.notEqual(state.getSelectionKey(), first);
});

test('clearing the mode removes marks, selection and enabled state', () => {
    const state = new FlexRoutingState();
    state.enable();
    state.toggleMark({ x: 2, y: 2 });
    state.selectAllMarks();

    state.clearMode();

    assert.equal(state.isEnabled(), false);
    assert.deepEqual(state.getMarks(), []);
    assert.equal(state.hasSelection(), false);
});

test('getters return copies, not live references', () => {
    const state = new FlexRoutingState();
    state.toggleMark({ x: 5, y: 5 });
    const marks = state.getMarks();
    marks[0].x = 99;
    assert.deepEqual(state.getMarks(), [{ x: 5, y: 5 }]);
});

test('replacing a tree removes stale cells from the previous route', () => {
    const state = new FlexRoutingState();
    state.recordWrites({ x: 1, y: 1 }, [
        { x: 2, y: 2, type: 1, rotation: 0, flipped: false },
        { x: 3, y: 2, type: 1, rotation: 0, flipped: false },
    ]);

    state.replaceTree({ x: 1, y: 1 }, [
        { x: 3, y: 2, type: 1, rotation: 1, flipped: false },
    ]);

    assert.deepEqual(state.getTree({ x: 1, y: 1 }), [
        { x: 3, y: 2, type: 1, rotation: 1, flipped: false },
    ]);
    assert.deepEqual(state.getAllTrees(), [{
        point: { x: 1, y: 1 },
        cells: [{ x: 3, y: 2, type: 1, rotation: 1, flipped: false }],
    }]);
});

test('clearMarks unmarks and deselects every input after confirming a staged route', () => {
    const state = new FlexRoutingState();
    state.enable();
    state.toggleMark({ x: 2, y: 4 });
    state.toggleMark({ x: 3, y: 4 });
    state.selectAllMarks();
    state.setRotation(2);
    state.toggleFlipped();

    state.clearMarks();

    assert.deepEqual(state.getMarks(), []);
    assert.deepEqual(state.getSelectedMarks(), []);
    assert.equal(state.hasSelection(), false);
    assert.deepEqual(state.getTransform(), { rotation: 0, flipped: false });
    assert.equal(state.isEnabled(), true);
});
