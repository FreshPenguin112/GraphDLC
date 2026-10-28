import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFlexSignalRoutes } from './FlexSignalValidator.ts';

const key = (p) => `${p.x},${p.y}`;
function makeBoard(entries) {
    const map = new Map(entries.map(([p, state]) => [key(p), state]));
    return (p) => map.get(key(p)) ?? null;
}
const wire = (x, y, rotation = 1, type = 1) => ({ x, y, type, rotation, flipped: false });

test('signal validation accepts a source connected to its own destination', () => {
    const live = makeBoard([[{ x: 0, y: 0 }, { type: 2, rotation: 0, flipped: false }]]);
    const steps = [wire(1, 0), wire(2, 0), wire(3, 0)];
    const result = validateFlexSignalRoutes([{ id: '0,0', end: { x: 3, y: 0 } }], steps, [], live);
    assert.equal(result.valid, true, result.reason);
});

test('signal validation rejects a route that activates another requested destination', () => {
    const live = makeBoard([
        [{ x: 0, y: 0 }, { type: 2, rotation: 0, flipped: false }],
        [{ x: 0, y: 2 }, { type: 2, rotation: 0, flipped: false }],
    ]);
    const steps = [wire(1, 0), wire(2, 0), wire(3, 0), wire(0, 1)];
    const result = validateFlexSignalRoutes([
        { id: '0,0', end: { x: 3, y: 0 } },
        { id: '0,2', end: { x: 0, y: 1 } },
    ], steps, [], live);
    assert.equal(result.valid, false);
    assert.match(result.reason, /also reaches another source/);
});

test('signal validation uses the blue splitter actual long and side outputs', () => {
    const live = makeBoard([[{ x: 0, y: 0 }, { type: 2, rotation: 0, flipped: false }]]);
    // rotation 1: the blue splitter's -2 forward output points right and its
    // side output points down; both destinations are reached by the same source.
    const steps = [
        { x: 1, y: 0, type: 13, rotation: 1, flipped: false },
        wire(2, 0), wire(3, 0),
        { x: 1, y: 1, type: 1, rotation: 0, flipped: false },
    ];
    const result = validateFlexSignalRoutes([
        { id: '0,0', end: { x: 3, y: 0 } },
        { id: '0,2', end: { x: 1, y: 1 } },
    ], steps, [], (p) => live(p) ?? (p.x === 0 && p.y === 2 ? { type: 2, rotation: 0, flipped: false } : null));
    assert.equal(result.valid, false);
});

test('signal validation allows one source to intentionally feed multiple destinations', () => {
    const live = makeBoard([[{ x: 0, y: 0 }, { type: 2, rotation: 0, flipped: false }]]);
    const steps = [wire(1, 0), wire(2, 0), wire(3, 0), wire(0, 1)];
    const result = validateFlexSignalRoutes([
        { id: '0,0', end: { x: 3, y: 0 } },
        { id: '0,0', end: { x: 0, y: 1 } },
    ], steps, [], live);
    assert.equal(result.valid, true, result.reason);
});


test('signal validation rejects arrows accidentally activated beyond an intended endpoint', () => {
    const live = makeBoard([
        [{ x: 0, y: 0 }, { type: 2, rotation: 0, flipped: false }],
        [{ x: 4, y: 0 }, { type: 1, rotation: 1, flipped: false }],
    ]);
    const steps = [wire(1, 0), wire(2, 0), wire(3, 0)];
    const result = validateFlexSignalRoutes(
        [{ id: '0,0', end: { x: 3, y: 0 } }], steps, [], live, 20_000, [],
    );
    assert.equal(result.valid, false);
    assert.match(result.reason, /unrelated existing arrow/);
});

test('signal validation permits tracked existing cable cells while rejecting stray live arrows', () => {
    const live = makeBoard([
        [{ x: 0, y: 0 }, { type: 2, rotation: 0, flipped: false }],
        [{ x: 1, y: 0 }, { type: 1, rotation: 1, flipped: false }],
    ]);
    const steps = [wire(2, 0), wire(3, 0)];
    const result = validateFlexSignalRoutes(
        [{ id: '0,0', end: { x: 3, y: 0 } }],
        steps,
        [],
        live,
        20_000,
        [{ x: 1, y: 0 }],
    );
    assert.equal(result.valid, true, result.reason);
});
