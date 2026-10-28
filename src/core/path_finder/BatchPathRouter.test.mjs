import assert from 'node:assert/strict';
import test from 'node:test';
import { canReservePath, reservePath } from './BatchPathReservations.ts';

const arrow = (overrides = {}) => ({
    x: 4,
    y: 7,
    type: 1,
    rotation: 0,
    flipped: false,
    ...overrides,
});

test('allows routes to share an identical arrow cell', () => {
    const reservations = new Map();
    const first = [arrow()];
    const second = [arrow()];

    assert.equal(canReservePath(second, reservations), true);
    assert.equal(reservePath(first, reservations), true);
    assert.equal(reservePath(second, reservations), true);
    assert.equal(reservations.size, 1);
});

test('rejects routes that need incompatible arrows in one cell', () => {
    const reservations = new Map();
    reservePath([arrow()], reservations);

    assert.equal(canReservePath([arrow({ rotation: 1 })], reservations), false);
    assert.equal(canReservePath([arrow({ type: 10 })], reservations), false);
    assert.equal(canReservePath([arrow({ flipped: true })], reservations), false);
});