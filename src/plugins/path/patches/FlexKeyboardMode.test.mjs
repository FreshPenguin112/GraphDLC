import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isFlexRoutingModeActive,
    shouldDispatchFlexKey,
} from './FlexKeyboardMode.ts';

test('normal rotation and flip keys pass through when B mode is off', () => {
    assert.equal(isFlexRoutingModeActive(false, false), false);
    for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyF']) {
        assert.equal(shouldDispatchFlexKey(key, false), false, `${key} should stay native`);
    }
    assert.equal(shouldDispatchFlexKey('KeyB', false), true, 'B must still toggle the mode');
});

test('flex shortcuts are dispatched only when both mode flags are active', () => {
    assert.equal(isFlexRoutingModeActive(true, true), true);
    assert.equal(isFlexRoutingModeActive(true, false), false);
    assert.equal(isFlexRoutingModeActive(false, true), false);
    for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'Space', 'Enter', 'Escape']) {
        assert.equal(shouldDispatchFlexKey(key, true), true, `${key} should reach flex mode`);
    }
});
