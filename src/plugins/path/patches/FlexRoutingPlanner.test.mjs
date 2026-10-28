import { getArrowRelations } from '../../../core/utils/getArrowRelations.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFlexSignalRoutes } from './FlexSignalValidator.ts';
import {
    FLEX_MAX_JUNCTIONS,
    isFlexUpgradeGeometryValid,
    branchCandidatesFor,
    buildFlexPlacementPlan,
    canApplyFlexSteps,
    transformArrowState,
    transformOffset,
} from './FlexRoutingPlanner.ts';

const IDENTITY = { rotation: 0, flipped: false };
const ARROW = 1;
const SPLITTER_FWD_SIDE = 7;
const SPLITTER_BOTH = 8;
const BLUE_ARROW = 10;
const DIAGONAL_ARROW = 11;

// Same rotation matrices as getRelativePosition in the game helpers.
const ROT = [
    { fx: 0, fy: 1, sx: 1, sy: 0 },
    { fx: -1, fy: 0, sx: 0, sy: 1 },
    { fx: 0, fy: -1, sx: -1, sy: 0 },
    { fx: 1, fy: 0, sx: 0, sy: -1 },
];
function rel(point, rotation, flipped, forward, sideways) {
    const m = ROT[rotation];
    const sd = flipped ? -sideways : sideways;
    return { x: point.x + forward * m.fx + sd * m.sx, y: point.y + forward * m.fy + sd * m.sy };
}

/** ARROW feeds forward by one cell; the splitters also feed a side. */
const outputOf = (point, state) => rel(point, state.rotation, state.flipped, -1, 0);
/** True when some output of the arrow at `point` lands on `target`. */
const feedsCell = (point, state, target) =>
    getArrowRelations(state.type).some(([f, sd]) => {
        const out = rel(point, state.rotation, state.flipped, f, sd);
        return out.x === target.x && out.y === target.y;
    });

function makeDeps({ arrows = new Map(), trees = new Map(), staged = new Set() } = {}) {
    const key = (p) => `${p.x},${p.y}`;
    return {
        getArrowState: (p) => arrows.get(key(p)) ?? null,
        isStagedCell: (p) => staged.has(key(p)),
        getOutputCell: (p, s) => outputOf(p, s),
        getRelativeCell: rel,
        getTree: (p) => trees.get(key(p)) ?? [],
    };
}

test('transform: a quarter turn rotates a relative offset', () => {
    assert.deepEqual(transformOffset(2, 1, { rotation: 1, flipped: false }), { x: -1, y: 2 });
    assert.deepEqual(transformOffset(2, 1, { rotation: 2, flipped: false }), { x: -2, y: -1 });
    assert.deepEqual(transformOffset(2, 1, { rotation: 3, flipped: false }), { x: 1, y: -2 });
});

test('transform: flip is applied before rotation, as in SelectedMap', () => {
    assert.deepEqual(transformOffset(2, 1, { rotation: 0, flipped: true }), { x: -2, y: 1 });
    assert.deepEqual(transformOffset(2, 1, { rotation: 1, flipped: true }), { x: -1, y: -2 });
});

test('transform: four quarter turns restore the original offset', () => {
    let point = { x: 3, y: -1 };
    for (let turn = 0; turn < 4; turn += 1) {
        point = transformOffset(point.x, point.y, { rotation: 1, flipped: false });
    }
    assert.deepEqual(point, { x: 3, y: -1 });
});

test('transform: flipping a vertical arrow reverses its facing', () => {
    assert.deepEqual(
        transformArrowState({ type: 1, rotation: 1, flipped: false }, { rotation: 0, flipped: true }),
        { type: 1, rotation: 3, flipped: true },
    );
});

test('plan: an empty mark becomes a request from its own cell to the cursor', () => {
    const plan = buildFlexPlacementPlan([{ x: 4, y: 7 }], { x: 4, y: 7 }, { x: 10, y: 7 }, IDENTITY, makeDeps());
    assert.equal(plan.requests.length, 1);
    assert.equal(plan.requests[0].id, '4,7');
    // The marker stays empty; its feeder must output into it.
    assert.ok(feedsCell(plan.requests[0].end, plan.ghosts[0].arrowState, { x: 10, y: 7 }));
    assert.notDeepEqual(plan.requests[0].end, { x: 10, y: 7 });
    assert.deepEqual(plan.requests[0].candidates, [{ start: { x: 4, y: 7 }, upgrades: [] }]);
    assert.equal(plan.blockedCount, 0);
});

test('plan: an arrow input starts from the cell it feeds, not its own cell', () => {
    const arrows = new Map([['4,7', { type: ARROW, rotation: 0, flipped: false }]]);
    const plan = buildFlexPlacementPlan([{ x: 4, y: 7 }], { x: 4, y: 7 }, { x: 10, y: 7 }, IDENTITY, makeDeps({ arrows }));
    assert.deepEqual(plan.requests[0].candidates[0].start, { x: 4, y: 6 });
});

test('plan: an occupied output cell blocks an input with no cable', () => {
    const arrows = new Map([
        ['4,7', { type: ARROW, rotation: 0, flipped: false }],
        ['4,6', { type: ARROW, rotation: 2, flipped: false }],
    ]);
    const plan = buildFlexPlacementPlan([{ x: 4, y: 7 }], { x: 4, y: 7 }, { x: 10, y: 7 }, IDENTITY, makeDeps({ arrows }));
    assert.equal(plan.requests.length, 0);
    assert.equal(plan.blockedCount, 1);
});

test('plan: an unroutable arrow type blocks its input', () => {
    const arrows = new Map([['4,7', { type: 2, rotation: 0, flipped: false }]]);
    const deps = makeDeps({ arrows });
    deps.getOutputCell = () => null;
    const plan = buildFlexPlacementPlan([{ x: 4, y: 7 }], { x: 4, y: 7 }, { x: 10, y: 7 }, IDENTITY, deps);
    assert.equal(plan.blockedCount, 1);
});

test('plan: a pattern keeps its spacing around the grab cell', () => {
    const plan = buildFlexPlacementPlan(
        [{ x: 0, y: 0 }, { x: 2, y: 0 }],
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        IDENTITY,
        makeDeps(),
    );
    assert.ok(feedsCell(plan.ghosts[0].point, plan.ghosts[0].arrowState, { x: 5, y: 5 }));
    assert.ok(feedsCell(plan.ghosts[1].point, plan.ghosts[1].arrowState, { x: 7, y: 5 }));
});

test('plan: rotation moves destinations around the grab cell', () => {
    const plan = buildFlexPlacementPlan([{ x: 2, y: 0 }], { x: 0, y: 0 }, { x: 5, y: 5 }, { rotation: 1, flipped: false }, makeDeps());
    // Marker at (5,7) after rotating; its feeder must output into it.
    assert.ok(feedsCell(plan.ghosts[0].point, plan.ghosts[0].arrowState, { x: 5, y: 7 }));
});

test('plan: an input already connected to its destination needs nothing', () => {
    const plan = buildFlexPlacementPlan([{ x: 4, y: 7 }], { x: 4, y: 7 }, { x: 4, y: 7 }, IDENTITY, makeDeps());
    assert.equal(plan.requests.length, 0);
    assert.equal(plan.blockedCount, 0);
});

test('splitter: a plain cable arrow reuses its open forward output and can add side/backward branches', () => {
    // Cable arrow at (5,5) pointing up (rotation 0): forward is (5,4), sides (4,5)/(6,5), backward (5,6).
    const tree = [{ x: 5, y: 5, type: ARROW, rotation: 0, flipped: false }];
    const candidates = branchCandidatesFor(tree, { x: 9, y: 9 }, makeDeps());

    const starts = candidates.map((c) => `${c.start.x},${c.start.y}`).sort();
    assert.deepEqual(starts, ['4,5', '5,4', '5,6', '6,5']);
    const sideCandidates = candidates.filter((c) => c.upgrades[0]?.type === SPLITTER_FWD_SIDE);
    assert.equal(sideCandidates.length, 2);
    const directForward = candidates.find((candidate) => candidate.start.x === 5 && candidate.start.y === 4);
    assert.deepEqual(directForward?.upgrades, [], 'the existing forward output needs no upgrade');
    for (const candidate of candidates.filter((candidate) => candidate.upgrades.length > 0)) {
        assert.equal(candidate.upgrades[0].x, 5);
        assert.equal(candidate.upgrades[0].y, 5);
    }
});

test('splitter: added-output branches are adjacent, while an existing forward output may be reused', () => {
    const tree = [{ x: 5, y: 5, type: ARROW, rotation: 0, flipped: false }];
    const candidates = branchCandidatesFor(tree, { x: 9, y: 9 }, makeDeps());
    const directForward = candidates.find((candidate) => candidate.start.x === 5 && candidate.start.y === 4);
    assert.deepEqual(directForward?.upgrades, []);
    for (const candidate of candidates.filter((candidate) => candidate.upgrades.length > 0)) {
        const gap = Math.abs(candidate.start.x - 5) + Math.abs(candidate.start.y - 5);
        assert.equal(gap, 1, 'new splitter output starts next to the junction');
        assert.notDeepEqual(candidate.start, { x: 5, y: 4 });
    }
});

test('splitter: a forward-plus-side junction reuses its current side and upgrades only the missing side', () => {
    const tree = [{ x: 5, y: 5, type: SPLITTER_FWD_SIDE, rotation: 0, flipped: false }];
    const candidates = branchCandidatesFor(tree, { x: 9, y: 9 }, makeDeps());
    assert.deepEqual(candidates.map((c) => `${c.start.x},${c.start.y}`).sort(), ['4,5', '5,4', '6,5']);
    const existingOutput = candidates.find((c) => c.start.x === 6 && c.start.y === 5);
    const existingForward = candidates.find((c) => c.start.x === 5 && c.start.y === 4);
    const newOutput = candidates.find((c) => c.start.x === 4 && c.start.y === 5);
    assert.deepEqual(existingOutput?.upgrades, [], 'already-emitted side needs no splitter replacement');
    assert.deepEqual(existingForward?.upgrades, [], 'already-emitted forward output needs no splitter replacement');
    assert.equal(newOutput?.upgrades[0]?.type, SPLITTER_BOTH, 'missing side needs type 8');
});

test('splitter: a type 8 junction reuses existing outputs but offers no further upgrade', () => {
    const tree = [{ x: 5, y: 5, type: SPLITTER_BOTH, rotation: 0, flipped: false }];
    const candidates = branchCandidatesFor(tree, { x: 9, y: 9 }, makeDeps());
    assert.deepEqual(candidates.map((c) => `${c.start.x},${c.start.y}`).sort(), ['4,5', '5,4', '6,5']);
    assert.ok(candidates.every((candidate) => candidate.upgrades.length === 0));
});


test('splitter: a red forward/back splitter can branch from either already-emitted output', () => {
    const tree = [{ x: 5, y: 5, type: 6, rotation: 0, flipped: false }];
    const candidates = branchCandidatesFor(tree, { x: 9, y: 9 }, makeDeps());
    assert.deepEqual(candidates.map((candidate) => `${candidate.start.x},${candidate.start.y}`).sort(), ['5,4', '5,6']);
    assert.ok(candidates.every((candidate) => candidate.upgrades.length === 0));
});

test('splitter: an occupied side cell is not offered', () => {
    const arrows = new Map([['6,5', { type: ARROW, rotation: 0, flipped: false }]]);
    const tree = [{ x: 5, y: 5, type: ARROW, rotation: 0, flipped: false }];
    const candidates = branchCandidatesFor(tree, { x: 9, y: 9 }, makeDeps({ arrows }));
    assert.deepEqual(candidates.map((c) => `${c.start.x},${c.start.y}`).sort(), ['4,5', '5,4', '5,6']);
});

test('splitter: a branch can never start on a marker cell', () => {
    const tree = [{ x: 5, y: 5, type: ARROW, rotation: 0, flipped: false }];
    const candidates = branchCandidatesFor(
        tree,
        { x: 9, y: 9 },
        makeDeps(),
        new Set(['6,5']),
    );
    assert.ok(
        candidates.every((candidate) => !(candidate.start.x === 6 && candidate.start.y === 5)),
        'a marker can be an output target, but never a route start/write cell',
    );
});

test('splitter: a staged side cell can be reused by a later route', () => {
    const arrows = new Map([['6,5', { type: ARROW, rotation: 1, flipped: false }]]);
    const staged = new Set(['6,5']);
    const tree = [{ x: 5, y: 5, type: ARROW, rotation: 0, flipped: false }];
    const candidates = branchCandidatesFor(tree, { x: 9, y: 9 }, makeDeps({ arrows, staged }));
    assert.ok(candidates.some((candidate) => candidate.start.x === 6 && candidate.start.y === 5));
});

test('splitter: blue arrows gain a blue side, and diagonals gain a forward output', () => {
    const blueTree = [{ x: 5, y: 5, type: BLUE_ARROW, rotation: 0, flipped: false }];
    const blue = branchCandidatesFor(blueTree, { x: 9, y: 9 }, makeDeps());
    const blueUpgrades = blue.filter((c) => c.upgrades.length > 0);
    assert.ok(blueUpgrades.some((c) => c.upgrades[0].type === 13 && c.start.x === 6 && c.start.y === 5));
    assert.ok(blueUpgrades.some((c) => c.upgrades[0].type === 12 && c.start.x === 5 && c.start.y === 4));
    assert.ok(blueUpgrades.every((c) => [12, 13].includes(c.upgrades[0].type)), 'blue arrows never become red splitters');
    assert.ok(blue.some((c) => c.upgrades.length === 0 && c.start.x === 5 && c.start.y === 3), 'existing long output can be reused');

    const diagTree = [{ x: 5, y: 5, type: DIAGONAL_ARROW, rotation: 0, flipped: false }];
    const diag = branchCandidatesFor(diagTree, { x: 9, y: 9 }, makeDeps());
    const diagUpgrades = diag.filter((c) => c.upgrades.length > 0);
    assert.ok(diagUpgrades.length > 0 && diagUpgrades.every((c) => c.upgrades[0].type === 14));
    assert.ok(diag.some((c) => c.upgrades.length === 0), 'existing diagonal output can be reused');
});

test('splitter: considers more distant junctions while bounding the search', () => {
    const tree = [];
    for (let x = 0; x < FLEX_MAX_JUNCTIONS + 10; x += 1) {
        tree.push({ x, y: 0, type: ARROW, rotation: 0, flipped: false });
    }
    const candidates = branchCandidatesFor(tree, { x: 0, y: 3 }, makeDeps());
    const junctionXs = new Set(candidates.filter((c) => c.upgrades.length > 0).map((c) => c.upgrades[0].x));
    assert.equal(junctionXs.size, FLEX_MAX_JUNCTIONS);
    assert.ok(junctionXs.has(0));
    assert.ok(!junctionXs.has(FLEX_MAX_JUNCTIONS + 9));
});

test('plan: an input with a cable branches from it and gets no fresh start', () => {
    const arrows = new Map([
        ['4,7', { type: ARROW, rotation: 0, flipped: false }],
        ['4,6', { type: ARROW, rotation: 0, flipped: false }],
    ]);
    const trees = new Map([
        ['4,7', [
            { x: 4, y: 6, type: ARROW, rotation: 0, flipped: false },
        ]],
    ]);
    const plan = buildFlexPlacementPlan([{ x: 4, y: 7 }], { x: 4, y: 7 }, { x: 10, y: 6 }, IDENTITY, makeDeps({ arrows, trees }));
    assert.equal(plan.requests.length, 1);
    const starts = plan.requests[0].candidates.map((c) => c.start);
    assert.ok(starts.every((s) => !(s.x === 4 && s.y === 6)), 'the occupied tree cell is never a start');
    assert.ok(plan.requests[0].candidates.some((c) => c.upgrades.length === 1));
    assert.ok(plan.requests[0].candidates.some((c) => c.upgrades.length === 0), 'an unused existing output needs no new splitter');
});

test('canApplyFlexSteps: empty cells and identical arrows are acceptable', () => {
    const steps = [
        { x: 1, y: 1, type: 1, rotation: 2, flipped: false },
        { x: 2, y: 1, type: 1, rotation: 0, flipped: false },
    ];
    const occupied = new Map([['2,1', { type: 1, rotation: 0, flipped: false }]]);
    assert.equal(canApplyFlexSteps(steps, (p) => occupied.get(`${p.x},${p.y}`) ?? null), true);
});

test('canApplyFlexSteps: a different arrow in a target cell is rejected', () => {
    const steps = [{ x: 2, y: 1, type: 1, rotation: 0, flipped: false }];
    assert.equal(canApplyFlexSteps(steps, () => ({ type: 1, rotation: 1, flipped: false })), false);
});

test('canApplyFlexSteps: a staged cell can be replaced by a different arrow', () => {
    const steps = [{ x: 2, y: 1, type: 1, rotation: 0, flipped: false }];
    assert.equal(
        canApplyFlexSteps(
            steps,
            () => ({ type: 1, rotation: 1, flipped: false }),
            (point) => point.x === 2 && point.y === 1,
        ),
        true,
    );
});

test('upgrade geometry preserves every old output and adds exactly the requested branch', () => {
    const original = { x: 5, y: 5, type: ARROW, rotation: 0, flipped: false };
    const valid = { ...original, type: SPLITTER_FWD_SIDE };
    assert.equal(isFlexUpgradeGeometryValid(original, valid, rel(original, 0, false, 0, 1), rel), true);
    // A splitter rotated the wrong way adds a different output and must be rejected.
    assert.equal(isFlexUpgradeGeometryValid(original, { ...valid, rotation: 1 }, rel(original, 0, false, 0, 1), rel), false);
});

test('blue splitter upgrade keeps its long output and adds only its intended branch', () => {
    const original = { x: 0, y: 0, type: BLUE_ARROW, rotation: 0, flipped: false };
    const valid = { ...original, type: 13 };
    assert.equal(isFlexUpgradeGeometryValid(original, valid, rel(original, 0, false, 0, 1), rel), true);
    assert.equal(isFlexUpgradeGeometryValid(original, { ...valid, flipped: true }, rel(original, 0, false, 0, 1), rel), false);
});

test('plan: a mark on a staged cable branches from its original input instead of moving the arrow', () => {
    const key = (p) => `${p.x},${p.y}`;
    const source = { x: 2, y: 5 };
    const markedCell = { x: 5, y: 5 };
    const arrowState = { type: ARROW, rotation: 0, flipped: false };
    const tree = [{ ...markedCell, ...arrowState }];
    const deps = makeDeps({
        arrows: new Map([[key(markedCell), arrowState]]),
        trees: new Map([[key(source), tree]]),
        staged: new Set([key(markedCell)]),
    });
    deps.getTreeOwner = (point) =>
        key(point) === key(markedCell) ? source : null;

    const marker = { x: 10, y: 5 };
    const plan = buildFlexPlacementPlan(
        [markedCell], markedCell, marker, IDENTITY, deps,
    );

    assert.equal(plan.requests.length, 1);
    assert.equal(plan.requests[0].id, key(source));
    assert.deepEqual(plan.ghosts[0].source, source);
    assert.deepEqual(plan.ghosts[0].marker, marker);
    assert.notDeepEqual(plan.ghosts[0].point, marker);
    assert.ok(
        plan.requests[0].candidates.length > 0,
        'the new destination should branch from the existing cable tree',
    );
});

test('plan: a moved arrow marker never lands on its marker; its feeder sits behind it, facing in', () => {
    const arrows = new Map([['4,7', { type: ARROW, rotation: 1, flipped: false }]]);
    const plan = buildFlexPlacementPlan([{ x: 4, y: 7 }], { x: 4, y: 7 }, { x: 10, y: 7 }, IDENTITY, makeDeps({ arrows }));
    const [ghost] = plan.ghosts;
    assert.notDeepEqual(ghost.point, { x: 10, y: 7 }, 'the marker cell must stay empty');
    assert.equal(ghost.arrowState.type, ARROW, 'a plain moved arrow keeps its type');
    assert.deepEqual(outputOf(ghost.point, ghost.arrowState), { x: 10, y: 7 });
    assert.deepEqual(plan.requests[0].end, ghost.point, 'the cable must end at the feeder');
});

test('plan: a marker may land over an occupied cell while its feeder stays separate', () => {
    const arrows = new Map([
        ['4,7', { type: ARROW, rotation: 0, flipped: false }],
        ['10,7', { type: ARROW, rotation: 2, flipped: false }],
    ]);
    const plan = buildFlexPlacementPlan(
        [{ x: 4, y: 7 }],
        { x: 4, y: 7 },
        { x: 10, y: 7 },
        IDENTITY,
        makeDeps({ arrows }),
    );
    const [ghost] = plan.ghosts;
    assert.equal(plan.blockedCount, 0);
    assert.deepEqual(ghost.marker, { x: 10, y: 7 });
    assert.notDeepEqual(ghost.point, ghost.marker, 'the existing target cell stays a marker, not a feeder');
    assert.deepEqual(outputOf(ghost.point, ghost.arrowState), ghost.marker);
    assert.equal(ghost.blocked, false);
});

test('plan: an occupied feeder blocks the move instead of falling back to an arrow on the marker', () => {
    const arrows = new Map([
        ['4,7', { type: ARROW, rotation: 0, flipped: false }],
        ['10,7', { type: ARROW, rotation: 2, flipped: false }],
        ['10,8', { type: ARROW, rotation: 2, flipped: false }],
    ]);
    const plan = buildFlexPlacementPlan(
        [{ x: 4, y: 7 }],
        { x: 4, y: 7 },
        { x: 10, y: 7 },
        IDENTITY,
        makeDeps({ arrows }),
    );
    const [ghost] = plan.ghosts;
    assert.equal(plan.blockedCount, 1);
    assert.equal(plan.requests.length, 0);
    assert.deepEqual(ghost.marker, { x: 10, y: 7 });
    assert.deepEqual(ghost.point, ghost.marker, 'blocked marker preview does not invent a feeder cell');
    assert.equal(ghost.arrowState, null, 'blocked marker must not draw or write an arrow');
    assert.equal(ghost.blocked, true);
});

test('plan: a moved blue arrow sits two cells behind its marker, as it outputs two ahead', () => {
    const arrows = new Map([['4,7', { type: BLUE_ARROW, rotation: 0, flipped: false }]]);
    const plan = buildFlexPlacementPlan([{ x: 4, y: 7 }], { x: 4, y: 7 }, { x: 10, y: 7 }, IDENTITY, makeDeps({ arrows }));
    const [ghost] = plan.ghosts;
    assert.equal(ghost.arrowState.type, BLUE_ARROW);
    assert.deepEqual(ghost.point, { x: 10, y: 9 });
});

test('plan: an empty marker is fed by an arrow whose output lands on it, and the marker stays empty', () => {
    for (const rotation of [0, 1, 2, 3]) {
        const plan = buildFlexPlacementPlan([{ x: 4, y: 7 }], { x: 4, y: 7 }, { x: 10, y: 7 }, { rotation, flipped: false }, makeDeps());
        const [ghost] = plan.ghosts;
        assert.notDeepEqual(ghost.point, { x: 10, y: 7 }, 'rotation ' + rotation);
        assert.ok(
            getArrowRelations(ghost.arrowState.type).some(([f, sd]) => {
                const out = rel(ghost.point, ghost.arrowState.rotation, ghost.arrowState.flipped, f, sd);
                return out.x === 10 && out.y === 7;
            }),
            'rotation ' + rotation + ' feeder must output into the marker',
        );
    }
});

test('plan: an empty marker close to the cable gets a cheap red arrow', () => {
    // Source is straight below the marker, so the cheapest red feeder wins.
    const plan = buildFlexPlacementPlan([{ x: 4, y: 7 }], { x: 4, y: 7 }, { x: 4, y: 3 }, IDENTITY, makeDeps());
    assert.equal(plan.ghosts[0].arrowState.type, ARROW);
});

test('plan: a marker already fed by its input produces no request and no ghost', () => {
    const arrows = new Map([['4,7', { type: ARROW, rotation: 0, flipped: false }]]);
    const plan = buildFlexPlacementPlan([{ x: 4, y: 7 }], { x: 4, y: 7 }, { x: 4, y: 6 }, IDENTITY, makeDeps({ arrows }));
    assert.equal(plan.requests.length, 0);
    assert.equal(plan.ghosts.length, 0);
});


test('validator: a feeder may output into an occupied marker and stops there', () => {
    const writes = [
        { x: 9, y: 8, type: ARROW, rotation: 1, flipped: false },
        { x: 10, y: 8, type: ARROW, rotation: 0, flipped: false },
    ];
    const live = new Map([
        ['10,7', { type: ARROW, rotation: 0, flipped: false }],
        ['10,6', { type: ARROW, rotation: 0, flipped: false }],
    ]);
    const result = validateFlexSignalRoutes(
        [{ id: '9,8', end: { x: 10, y: 8 }, marker: { x: 10, y: 7 } }],
        writes,
        [],
        (point) => live.get(`${point.x},${point.y}`) ?? null,
        20_000,
        [{ x: 10, y: 7 }],
    );
    assert.equal(result.valid, true, result.reason);
});

test('validator: any attempted write on a marker is rejected', () => {
    const result = validateFlexSignalRoutes(
        [{ id: '9,8', end: { x: 10, y: 8 }, marker: { x: 10, y: 7 } }],
        [
            { x: 9, y: 8, type: ARROW, rotation: 1, flipped: false },
            { x: 10, y: 8, type: ARROW, rotation: 0, flipped: false },
            { x: 10, y: 7, type: ARROW, rotation: 0, flipped: false },
        ],
        [],
        () => null,
    );
    assert.equal(result.valid, false);
    assert.match(result.reason, /arrow on marker/);
});
