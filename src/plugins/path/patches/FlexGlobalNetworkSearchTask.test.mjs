import assert from 'node:assert/strict';
import test from 'node:test';
import { FlexGlobalNetworkSearchTask } from './FlexGlobalNetworkSearchTask.ts';
import { validateFlexSignalRoutes } from './FlexSignalValidator.ts';

function emptyBoard() {
    return { getArrow: () => null };
}

function runTask(task, maxIterations = 20000) {
    for (let i = 0; i < maxIterations; i += 1) {
        if (task.step(500)) return task.getResult();
    }
    throw new Error('global flex route search did not terminate');
}

test('global flex search rebuilds multiple endpoints from one source as one tree', () => {
    const intents = [
        { id: '-1,0', source: { x: -1, y: 0 }, start: { x: 0, y: 0 }, end: { x: 8, y: 0 } },
        { id: '-1,0', source: { x: -1, y: 0 }, start: { x: 0, y: 0 }, end: { x: 5, y: 4 } },
    ];
    const result = runTask(new FlexGlobalNetworkSearchTask(
        emptyBoard(), intents, new Map(), new Set(), () => null, 0,
    ));

    assert.equal(result.complete, true);
    assert.equal(result.results.length, 2);
    assert.ok(result.results.some((route) => route.upgrades.length > 0), 'one route should create a real splitter branch');
    assert.ok(result.steps.length > 0);
});

test('global flex search can rebuild older routes when the route order changes', () => {
    const intents = [
        { id: '-1,0', source: { x: -1, y: 0 }, start: { x: 0, y: 0 }, end: { x: 9, y: 0 } },
        { id: '-1,0', source: { x: -1, y: 0 }, start: { x: 0, y: 0 }, end: { x: 4, y: 6 } },
        { id: '-1,0', source: { x: -1, y: 0 }, start: { x: 0, y: 0 }, end: { x: 7, y: -5 } },
    ];
    const first = runTask(new FlexGlobalNetworkSearchTask(
        emptyBoard(), intents, new Map(), new Set(), () => null, 0,
    ));
    const alternate = runTask(new FlexGlobalNetworkSearchTask(
        emptyBoard(), intents, new Map(), new Set(), () => null, 1,
    ));

    assert.equal(first.complete, true);
    assert.equal(alternate.complete, true);
    assert.equal(first.results.length, 3);
    assert.equal(alternate.results.length, 3);
    assert.notDeepEqual(first.steps, alternate.steps, 'the alternate route order should produce a freshly rebuilt layout');
});


test('global flex search can rewrite an earlier staged arrow when adding an overlapping cable', () => {
    const source = { x: -1, y: 0 };
    const start = { x: 0, y: 0 };
    const firstEnd = { x: -6, y: -7 };
    const secondEnd = { x: -6, y: -6 };
    const id = '-1,0';
    const states = new Map([
        ['-1,0', { type: 2, rotation: 0, flipped: false }],
        ['-6,-7', { type: 23, rotation: 0, flipped: false }],
        ['-6,-6', { type: 23, rotation: 0, flipped: false }],
    ]);
    const readLive = (point) => states.get(`${point.x},${point.y}`) ?? null;
    const board = {
        getArrow(x, y) {
            const state = readLive({ x, y });
            return state ? { ...state } : null;
        },
    };
    const firstIntent = { id, source, start, end: firstEnd };
    const firstOnly = runTask(new FlexGlobalNetworkSearchTask(
        board, [firstIntent], new Map(), new Set(), readLive, 0,
    ));
    const combined = runTask(new FlexGlobalNetworkSearchTask(
        board,
        [firstIntent, { id, source, start, end: secondEnd }],
        new Map(), new Set(), readLive, 2,
    ));

    const oldState = firstOnly.steps.find((step) => step.x === -3 && step.y === -3);
    const rewritten = combined.steps.find((step) => step.x === -3 && step.y === -3);
    assert.equal(oldState?.type, 1, 'the first cable initially uses a plain arrow');
    assert.equal(rewritten?.type, 7, 'the overlapping route can turn that cell into a red splitter');
    assert.ok(combined.complete);
});

test('global retries can recover a valid network after an overlap temporarily breaks an older route', () => {
    const source = { x: -1, y: 0 };
    const start = { x: 0, y: 0 };
    const ends = [{ x: -6, y: -7 }, { x: -6, y: -6 }];
    const id = '-1,0';
    const intents = ends.map((end) => ({ id, source, start, end }));
    const states = new Map([
        ['-1,0', { type: 2, rotation: 0, flipped: false }],
        ...ends.map((end) => [`${end.x},${end.y}`, { type: 23, rotation: 0, flipped: false }]),
    ]);
    const readLive = (point) => states.get(`${point.x},${point.y}`) ?? null;
    const board = {
        getArrow(x, y) {
            const state = readLive({ x, y });
            return state ? { ...state } : null;
        },
    };
    const key = (point) => `${point.x},${point.y}`;
    const blocked = new Set();
    const protectedCells = new Set(intents.flatMap((intent) => [key(intent.start), key(intent.end)]));
    let accepted = null;

    for (let attempt = 0; attempt < 96; attempt += 1) {
        const result = runTask(new FlexGlobalNetworkSearchTask(
            board, intents, new Map(), blocked, readLive, attempt,
        ));
        const validation = result.complete
            ? validateFlexSignalRoutes(intents.map(({ id: routeId, end }) => ({ id: routeId, end })), result.steps, [], readLive)
            : { valid: false, source };
        if (result.complete && validation.valid) {
            accepted = result;
            break;
        }

        const sourceKey = validation.source ? key(validation.source) : null;
        const preferred = sourceKey ? result.results.filter((route) => route.id === sourceKey) : [];
        const routePool = preferred.length ? preferred : [...result.results].reverse();
        const possible = new Map();
        for (const route of routePool) {
            for (const step of route.steps) {
                const cellKey = key(step);
                protectedCells.add(key(route.steps[0] ?? step));
                for (const upgrade of route.upgrades) protectedCells.add(key(upgrade));
                if (protectedCells.has(cellKey) || blocked.has(cellKey)) continue;
                possible.set(cellKey, step);
            }
        }
        const cells = [...possible.values()];
        if (cells.length > 0) {
            const sourceKeyLength = sourceKey ? sourceKey.length : 0;
            const index = (attempt * 11 + sourceKeyLength) % cells.length;
            blocked.add(key(cells[index]));
        }
    }

    assert.ok(accepted, 'a later global attempt should find a valid overlap layout');
    const validation = validateFlexSignalRoutes(
        intents.map(({ id: routeId, end }) => ({ id: routeId, end })),
        accepted.steps,
        [],
        readLive,
    );
    assert.equal(validation.valid, true);
});

test('global flex search writes an arrow on every destination so the network validates', () => {
    const board = { getArrow: () => null, graph: { getNode: () => ({ backLinks: [] }) } };
    const intents = [
        { id: '-1,0', source: { x: -1, y: 0 }, start: { x: -1, y: 0 }, end: { x: 8, y: 0 } },
        { id: '-1,0', source: { x: -1, y: 0 }, start: { x: -1, y: 0 }, end: { x: 5, y: 4 } },
    ];
    const result = runTask(new FlexGlobalNetworkSearchTask(board, intents, new Map(), new Set(), () => null, 0));

    assert.equal(result.complete, true);
    for (const intent of intents) {
        assert.ok(
            result.steps.some((step) => step.x === intent.end.x && step.y === intent.end.y),
            `destination ${intent.end.x},${intent.end.y} must hold an arrow`,
        );
    }
    const validation = validateFlexSignalRoutes(
        intents.map((intent) => ({ id: intent.id, end: intent.end })),
        result.steps,
        [],
        () => null,
    );
    assert.equal(validation.valid, true, validation.reason);
});

test('global flex search places the moved input arrow on an arrow-source destination', () => {
    const moved = { type: 1, rotation: 0, flipped: false };
    const board = { getArrow: () => null, graph: { getNode: () => ({ backLinks: [] }) } };
    const intents = [
        {
            id: '-2,0',
            source: { x: -2, y: 0 },
            start: { x: -2, y: -1 },
            end: { x: 4, y: 2 },
            endArrow: moved,
        },
    ];
    const result = runTask(new FlexGlobalNetworkSearchTask(board, intents, new Map(), new Set(), () => null, 0));

    assert.equal(result.complete, true);
    const destination = result.steps.find((step) => step.x === 4 && step.y === 2);
    assert.deepEqual(
        { type: destination?.type, rotation: destination?.rotation, flipped: destination?.flipped },
        moved,
    );
});
