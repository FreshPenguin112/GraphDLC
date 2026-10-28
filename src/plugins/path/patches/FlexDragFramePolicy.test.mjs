import test from 'node:test';
import assert from 'node:assert/strict';
import { getFlexDragFrameAction } from './FlexDragFramePolicy.ts';

test('a released preview keeps the normal game update loop responsive', () => {
    assert.equal(
        getFlexDragFrameAction(false, true, false, true),
        'keep-pending',
    );
});

test('a pending preview can be replaced by another drag from a selected marker', () => {
    assert.equal(
        getFlexDragFrameAction(false, true, true, true),
        'start-drag',
    );
});

test('a pending preview is not replaced by a drag from an unselected cell', () => {
    assert.equal(
        getFlexDragFrameAction(false, true, true, false),
        'keep-pending',
    );
});

test('a live flex drag owns the frame until the mouse is released', () => {
    assert.equal(
        getFlexDragFrameAction(true, false, true, true),
        'update-drag',
    );
    assert.equal(
        getFlexDragFrameAction(true, false, false, true),
        'drop-drag',
    );
});

test('idle flex mode leaves the game update loop alone', () => {
    assert.equal(
        getFlexDragFrameAction(false, false, false, false),
        'idle',
    );
});
