import type { ArrowType } from '../../../core/utils/ArrowType';
import { getArrowRelations } from '../../../core/utils/getArrowRelations';
import type { FlexTransform } from './FlexRoutingState';
import type { FlexArrowState, FlexGhost, GridPoint } from './types';

/*
 * Pure flex-routing geometry. This module has no runtime imports so that its
 * behaviour can be tested directly; anything that touches the game map is
 * passed in through FlexPlanDeps.
 */

/** Cells of an input's own cable, used as splitter branch points. */
export interface FlexTreeCell {
    x: number;
    y: number;
    type: ArrowType;
    rotation: number;
    flipped: boolean;
}

/** A write to an existing cable cell, such as a plain arrow becoming a splitter. */
export type FlexUpgrade = FlexTreeCell;

export interface FlexBranchCandidate {
    start: GridPoint;
    upgrades: FlexUpgrade[];
}

export interface FlexBranchRequest {
    id: string;
    end: GridPoint;
    candidates: FlexBranchCandidate[];
}

export interface FlexPlanDeps {
    /** Live arrow at a cell, or null when the cell is empty. */
    getArrowState(point: GridPoint): FlexArrowState | null;
    /**
     * True when the arrow is only part of the uncommitted flex preview.
     * Later drops may route through these cells and replace their arrows.
     */
    isStagedCell?(point: GridPoint): boolean;
    /**
     * The cell an existing arrow feeds into, where a new cable must begin.
     * Returns null when that arrow type cannot be routed from.
     */
    getOutputCell(point: GridPoint, state: FlexArrowState): GridPoint | null;
    /** The cell reached by moving `forward` and `sideways` in an arrow's frame. */
    getRelativeCell(
        point: GridPoint,
        rotation: number,
        flipped: boolean,
        forward: number,
        sideways: number,
    ): GridPoint;
    /** Cable cells this input already owns, in no particular order. */
    getTree(point: GridPoint): FlexTreeCell[];
    /**
     * The owning input when `point` lies on an existing cable, including a
     * staged preview cable. Marks placed on cable cells branch from that input;
     * they must not turn the arrow under the mark into a movable new source.
     */
    getTreeOwner?(point: GridPoint): GridPoint | null;
    /** Destinations already owned by the staged preview; they remain marker-only cells. */
    getReservedMarkers?(): readonly GridPoint[];
}

export interface FlexPlacementPlan {
    requests: FlexBranchRequest[];
    ghosts: FlexGhost[];
    blockedCount: number;
}

export interface FlexStepLike {
    x: number;
    y: number;
    type: number;
    rotation: number;
    flipped: boolean;
}

/** Only the nearest cable cells are offered as branch points, to bound work. */
export const FLEX_MAX_JUNCTIONS = 256;

/** Turns -0 into 0 so coordinate results compare cleanly. */
function normalizeZero(value: number): number {
    return value === 0 ? 0 : value;
}

/**
 * Applies flip, then rotation, to a relative offset. This is the same order
 * as SelectedMap.rotateOrFlipArrows, so flex patterns move like native
 * selections.
 */
export function transformOffset(
    dx: number,
    dy: number,
    transform: FlexTransform,
): GridPoint {
    const x = transform.flipped ? -dx : dx;
    const y = dy;

    switch (transform.rotation) {
        case 1:
            return { x: normalizeZero(-y), y: normalizeZero(x) };
        case 2:
            return { x: normalizeZero(-x), y: normalizeZero(-y) };
        case 3:
            return { x: normalizeZero(y), y: normalizeZero(-x) };
        default:
            return { x: normalizeZero(x), y: normalizeZero(y) };
    }
}

/**
 * Arrow orientation under the same transform. A flipped arrow facing up or
 * down reverses its facing, as native flipping does, and the flip flag toggles.
 */
export function transformArrowState<T extends FlexArrowState>(
    state: T,
    transform: FlexTransform,
): T {
    let rotation = state.rotation;
    if (transform.flipped && (rotation === 1 || rotation === 3)) {
        rotation = (rotation + 2) % 4;
    }
    rotation = (rotation + transform.rotation) % 4;

    return {
        ...state,
        rotation,
        flipped: transform.flipped ? !state.flipped : state.flipped,
    };
}

function samePoint(a: GridPoint, b: GridPoint): boolean {
    return a.x === b.x && a.y === b.y;
}

function manhattan(a: GridPoint, b: GridPoint): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Single-output upgrades that keep an arrow's existing outputs and add exactly
 * one more. `added` is [forward, sideways] in the arrow's own frame, the same
 * convention as getArrowRelations. Each rule keeps the signal colour: red
 * splitters come from red arrows, and blue splitters from blue arrows.
 */
export interface FlexUpgradeRule {
    from: number;
    to: number;
    added: [number, number];
}

export const FLEX_UPGRADE_RULES: readonly FlexUpgradeRule[] = [
    { from: 1, to: 7, added: [0, 1] }, // arrow -> forward + side
    { from: 1, to: 6, added: [1, 0] }, // arrow -> forward + backward
    { from: 7, to: 8, added: [0, -1] }, // forward + side -> forward + both sides
    { from: 10, to: 13, added: [0, 1] }, // blue -> blue side + blue long
    { from: 10, to: 12, added: [-1, 0] }, // blue -> two blue forward outputs
    { from: 11, to: 14, added: [-1, 0] }, // diagonal -> diagonal + forward
];

function rulesFrom(type: number): readonly FlexUpgradeRule[] {
    return FLEX_UPGRADE_RULES.filter((rule) => rule.from === type);
}

/**
 * Return the exact world-space output cells of an arrow. This uses the same
 * relation table as the game graph, not the pathfinder's heuristic weights.
 */
export function getFlexArrowOutputs(
    cell: FlexTreeCell,
    getRelativeCell: FlexPlanDeps['getRelativeCell'],
): GridPoint[] {
    return getArrowRelations(cell.type as ArrowType).map(
        ([forward, sideways]) =>
            getRelativeCell(
                cell,
                cell.rotation,
                cell.flipped,
                forward,
                sideways,
            ),
    );
}

function pointSet(points: readonly GridPoint[]): Set<string> {
    return new Set(points.map((point) => `${point.x},${point.y}`));
}

/**
 * Reject splitter upgrades whose real output geometry differs from the
 * original arrow's outputs plus exactly the intended new branch. This catches
 * invalid type/rotation/flip combinations before they can create stray signals.
 */
export function isFlexUpgradeGeometryValid(
    original: FlexTreeCell,
    upgrade: FlexUpgrade,
    expectedAddedOutput: GridPoint,
    getRelativeCell: FlexPlanDeps['getRelativeCell'],
): boolean {
    const originalOutputs = pointSet(
        getFlexArrowOutputs(original, getRelativeCell),
    );
    const upgradedOutputs = pointSet(
        getFlexArrowOutputs(upgrade, getRelativeCell),
    );
    const expectedOutputs = new Set(originalOutputs);
    expectedOutputs.add(`${expectedAddedOutput.x},${expectedAddedOutput.y}`);
    if (expectedOutputs.size !== originalOutputs.size + 1) return false;
    if (upgradedOutputs.size !== expectedOutputs.size) return false;
    for (const output of expectedOutputs) {
        if (!upgradedOutputs.has(output)) return false;
    }
    return true;
}

/**
 * Branch points for one input's cable. Any cable cell that has an upgrade
 * rule can gain one output. The new output cell must be empty or part of the
 * mutable staged preview; the latter can be overwritten by the new route.
 * Both flip states of the upgraded splitter are tried, which lets the branch
 * go to either side.
 */
export function branchCandidatesFor(
    tree: readonly FlexTreeCell[],
    end: GridPoint,
    deps: Pick<
        FlexPlanDeps,
        'getArrowState' | 'getRelativeCell' | 'isStagedCell'
    >,
    forbiddenCells: ReadonlySet<string> = new Set(),
): FlexBranchCandidate[] {
    // Live arrows are real obstacles. Only soft, staged preview cells may be
    // reused because the whole staged network is rebuilt before it is committed.
    const isFree = (point: GridPoint) => {
        if (forbiddenCells.has(flexPointKey(point))) return false;
        if (deps.isStagedCell?.(point) === true) return true;
        return deps.getArrowState(point) === null;
    };
    const nearestTreeCells = [...tree]
        .sort((a, b) => manhattan(a, end) - manhattan(b, end))
        .slice(0, FLEX_MAX_JUNCTIONS);
    const upgradeJunctions = [...tree]
        .filter((cell) => rulesFrom(cell.type).length > 0)
        .sort((a, b) => manhattan(a, end) - manhattan(b, end))
        .slice(0, FLEX_MAX_JUNCTIONS);

    const candidates: FlexBranchCandidate[] = [];
    const seenStarts = new Set<string>();
    const treeKeys = new Set(tree.map((cell) => `${cell.x},${cell.y}`));

    // First reuse outputs that the existing arrow already has. A splitter may
    // have an unused side/long output that can be routed directly without
    // upgrading the junction at all. This is important for red and blue splitters:
    // don't force an upgrade (or change a working orientation) when the desired
    // output already exists.
    for (const junction of nearestTreeCells) {
        for (const start of getFlexArrowOutputs(
            junction,
            deps.getRelativeCell,
        )) {
            const startKey = `${start.x},${start.y}`;
            if (
                treeKeys.has(startKey) ||
                seenStarts.has(startKey) ||
                !isFree(start)
            )
                continue;
            seenStarts.add(startKey);
            candidates.push({ start, upgrades: [] });
        }
    }

    // Only consider upgrades that preserve every old output and add exactly the
    // intended new output. The upgraded state must not accidentally reverse the
    // already-working side of a red splitter or the long output of a blue one.
    for (const junction of upgradeJunctions) {
        for (const rule of rulesFrom(junction.type)) {
            for (const flipped of [junction.flipped, !junction.flipped]) {
                const start = deps.getRelativeCell(
                    junction,
                    junction.rotation,
                    flipped,
                    rule.added[0],
                    rule.added[1],
                );
                const startKey = `${start.x},${start.y}`;
                if (seenStarts.has(startKey) || !isFree(start)) continue;
                const upgrade: FlexUpgrade = {
                    x: junction.x,
                    y: junction.y,
                    type: rule.to as ArrowType,
                    rotation: junction.rotation,
                    flipped,
                };
                if (
                    !isFlexUpgradeGeometryValid(
                        junction,
                        upgrade,
                        start,
                        deps.getRelativeCell,
                    )
                ) {
                    continue;
                }
                seenStarts.add(startKey);
                candidates.push({ start, upgrades: [upgrade] });
            }
        }
    }
    return candidates;
}

/**
 * Arrows that may feed an empty marker, with a routing cost. The cheapest arrow
 * that fits the layout wins, so a plain red arrow is used when it can reach the
 * marker, and blue or splitter feeders only when they fit better.
 */
export const FLEX_FEEDER_CHOICES: readonly { type: number; weight: number }[] = [
    { type: 1, weight: 1 }, // red arrow
    { type: 11, weight: 1.5 }, // blue diagonal
    { type: 10, weight: 2 }, // blue two ahead
    { type: 7, weight: 2.5 }, // red up + right (left when flipped)
    { type: 14, weight: 3 }, // splitter: up + diagonal
    { type: 12, weight: 3.5 }, // blue two-ahead pair
    { type: 13, weight: 3.5 }, // blue side + long
];

/**
 * Cell where an arrow of this state must sit so that its `outputIndex`-th
 * output lands exactly on `marker`. A plain arrow sits one cell behind its
 * marker; a blue arrow sits two cells behind it.
 */
function feederCellFor(
    marker: GridPoint,
    state: FlexArrowState,
    outputIndex: number,
    deps: FlexPlanDeps,
): GridPoint | null {
    const relation = getArrowRelations(state.type as ArrowType)[outputIndex];
    if (!relation) return null;
    return deps.getRelativeCell(
        marker,
        state.rotation,
        state.flipped,
        -relation[0],
        -relation[1],
    );
}

/** A feeder cell is usable when it is empty and every other output lands on empty space. */
function isFeederPlacementFree(
    point: GridPoint,
    state: FlexArrowState,
    marker: GridPoint,
    excluded: ReadonlySet<string>,
    deps: FlexPlanDeps,
): boolean {
    const key = flexPointKey(point);
    if (excluded.has(key)) return false;

    const existing = deps.getArrowState(point);
    const isSameExistingArrow =
        existing !== null &&
        existing.type === state.type &&
        existing.rotation === state.rotation &&
        existing.flipped === state.flipped;
    // Never lay a different arrow over a live one. An exact match is reusable,
    // and staged preview arrows may be replaced when the global network is rebuilt.
    if (
        existing !== null &&
        !isSameExistingArrow &&
        deps.isStagedCell?.(point) !== true
    ) {
        return false;
    }
    for (const [forward, sideways] of getArrowRelations(state.type as ArrowType)) {
        const output = deps.getRelativeCell(
            point,
            state.rotation,
            state.flipped,
            forward,
            sideways,
        );
        // The marker is a sink: it is allowed to be occupied, and no arrow is
        // ever written there. Other occupied or reserved cells remain obstacles.
        if (samePoint(output, marker)) continue;
        const outputKey = flexPointKey(output);
        if (
            excluded.has(outputKey) ||
            (deps.getArrowState(output) !== null &&
                deps.isStagedCell?.(output) !== true)
        ) {
            return false;
        }
    }
    return true;
}

/**
 * Picks the feeder for an empty marker. Every candidate arrow type, rotation,
 * flip and output that lands on the marker is scored by its distance to the
 * source cable plus its routing cost. Nearby cables therefore get short, cheap
 * feeders, while cables that approach from an angle may get a diagonal or a
 * splitter.
 */
function chooseEmptyMarkerFeeder(
    marker: GridPoint,
    anchors: readonly GridPoint[],
    excluded: ReadonlySet<string>,
    deps: FlexPlanDeps,
): { point: GridPoint; state: FlexArrowState } | null {
    let best: { point: GridPoint; state: FlexArrowState; score: number } | null = null;
    for (const choice of FLEX_FEEDER_CHOICES) {
        const outputCount = getArrowRelations(choice.type as ArrowType).length;
        for (let rotation = 0; rotation < 4; rotation += 1) {
            for (const flipped of [false, true]) {
                const state: FlexArrowState = {
                    type: choice.type as ArrowType,
                    rotation,
                    flipped,
                };
                for (let index = 0; index < outputCount; index += 1) {
                    const point = feederCellFor(marker, state, index, deps);
                    if (
                        point === null ||
                        !isFeederPlacementFree(point, state, marker, excluded, deps)
                    )
                        continue;
                    const distance = Math.min(
                        ...anchors.map((anchor) => manhattan(anchor, point)),
                    );
                    const score = distance + choice.weight + index * 0.25;
                    if (best === null || score < best.score) {
                        best = { point, state, score };
                    }
                }
            }
        }
    }
    return best ? { point: best.point, state: best.state } : null;
}

function flexPointKey(point: GridPoint): string {
    return `${point.x},${point.y}`;
}

/**
 * Plans where every selected input should be connected.
 *
 * The selection moves as a rigid pattern around the grabbed mark, so each
 * marker's destination is the cursor plus the transformed offset from the grab.
 * Markers never receive an arrow on their own cell: they are power sinks, so the
 * feeding arrow sits behind them, facing into them, and the cable ends at that
 * feeder. A moved arrow keeps its type and orientation, placed by its main
 * output. An empty marker gets a situationally chosen feeder.
 */
export function buildFlexPlacementPlan(
    selected: readonly GridPoint[],
    grab: GridPoint,
    cursor: GridPoint,
    transform: FlexTransform,
    deps: FlexPlanDeps,
): FlexPlacementPlan {
    const requests: FlexBranchRequest[] = [];
    const ghosts: FlexGhost[] = [];
    let blockedCount = 0;

    // Marker cells and source cells are off limits to every feeder.
    const markerCells = new Set<string>();
    const excluded = new Set<string>();
    for (const point of deps.getReservedMarkers?.() ?? []) {
        const key = flexPointKey(point);
        markerCells.add(key);
        excluded.add(key);
    }
    for (const point of selected) {
        const sourceKey = flexPointKey(point);
        // Sources are unavailable as feeder placements, but are not target
        // markers after the selection moves. An empty source cell may be the
        // root of its own new route unless another destination reserves it.
        excluded.add(sourceKey);
        const offset = transformOffset(point.x - grab.x, point.y - grab.y, transform);
        const marker = { x: cursor.x + offset.x, y: cursor.y + offset.y };
        const markerKey = flexPointKey(marker);
        markerCells.add(markerKey);
        excluded.add(markerKey);
    }

    for (const point of selected) {
        const offset = transformOffset(point.x - grab.x, point.y - grab.y, transform);
        const marker = { x: cursor.x + offset.x, y: cursor.y + offset.y };
        // A mark is a movable destination handle, not a command to pick up the
        // arrow underneath it. If it sits on a saved preview cable, associate
        // the new destination with that cable's original input and let the
        // network solver add a branch (or upgrade a splitter) on the same tree.
        const owner = deps.getTreeOwner?.(point) ?? null;
        const source = owner ?? point;
        const key = flexPointKey(source);

        const state = deps.getArrowState(point);
        const ghostState = state ? transformArrowState(state, transform) : null;
        const tree = deps.getTree(source);
        const start = state ? deps.getOutputCell(point, state) : { ...point };

        // The input already feeds its marker, so there is nothing to route
        // and nothing to draw.
        const treeAlreadyFeedsMarker = tree.some((cell) =>
            samePoint(cell, marker) ||
            getFlexArrowOutputs(cell, deps.getRelativeCell).some((output) =>
                samePoint(output, marker),
            ),
        );
        const sourceAlreadyFeedsMarker =
            tree.length === 0 && start !== null && samePoint(start, marker);
        // A marker already reached by this input does not need another feeder.
        if (treeAlreadyFeedsMarker || sourceAlreadyFeedsMarker) continue;

        let feeder: GridPoint | null;
        let feederState: FlexArrowState | null;
        if (ghostState) {
            // Keep the selected arrow's type/orientation, but put it one of its
            // output offsets behind the marker. If that cell is not usable, fail
            // this marker; never fall back to placing the arrow on the marker.
            const candidate = feederCellFor(marker, ghostState, 0, deps);
            if (
                candidate !== null &&
                isFeederPlacementFree(candidate, ghostState, marker, excluded, deps)
            ) {
                feeder = candidate;
                feederState = ghostState;
            } else {
                feeder = null;
                feederState = null;
            }
        } else {
            const anchors: GridPoint[] = [
                { ...point },
                ...tree.map((cell) => ({ x: cell.x, y: cell.y })),
            ];
            const chosen = chooseEmptyMarkerFeeder(marker, anchors, excluded, deps);
            feeder = chosen?.point ?? null;
            feederState = chosen?.state ?? null;
        }

        if (feeder !== null) excluded.add(flexPointKey(feeder));

        const candidates: FlexBranchCandidate[] = [];
        if (tree.length === 0 && start !== null) {
            const startKey = flexPointKey(start);
            const startArrow = deps.getArrowState(start);
            const startIsUsable =
                !markerCells.has(startKey) &&
                (startArrow === null || deps.isStagedCell?.(start) === true);
            if (startIsUsable) candidates.push({ start, upgrades: [] });
        }
        if (feeder !== null) {
            candidates.push(...branchCandidatesFor(tree, feeder, deps, markerCells));
        }

        if (feeder === null || feederState === null || candidates.length === 0) {
            blockedCount += 1;
            ghosts.push({
                source: { ...source },
                marker: { ...marker },
                point: feeder ?? marker,
                // A missing feeder is a hard failure, not permission to draw an
                // arbitrary arrow on the marker cell.
                arrowState: feeder === null ? null : feederState,
                blocked: true,
            });
            continue;
        }

        requests.push({ id: key, end: feeder, candidates });
        ghosts.push({
            source: { ...source },
            marker: { ...marker },
            point: feeder,
            arrowState: feederState,
            blocked: false,
        });
    }

    return { requests, ghosts, blockedCount };
}

/**
 * True when every planned cell is empty, already matches, or is explicitly
 * allowed to replace an earlier staged write. Live board arrows remain guarded.
 */
export function canApplyFlexSteps(
    steps: readonly FlexStepLike[],
    getArrowState: (point: GridPoint) => FlexArrowState | null,
    canReplace?: (point: GridPoint) => boolean,
): boolean {
    return steps.every((step) => {
        const existing = getArrowState(step);
        if (existing === null) return true;
        if (canReplace?.(step) === true) return true;
        return (
            existing.type === step.type &&
            existing.rotation === step.rotation &&
            existing.flipped === step.flipped
        );
    });
}
