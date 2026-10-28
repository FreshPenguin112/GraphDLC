import type { GameMap } from '@logic-arrows/game-logic/game-map';
import type { BranchResult } from '../../../core/path_finder/BranchRouteSearchTask';
import { PathFindingTask } from '../../../core/path_finder/PathFindingTask';
import type { PathStep } from '../../../core/path_finder/types';
import type { ITask } from '../../../core/task/ITask';
import { getRelativePosition } from '../../../core/utils/getRelativePosition';
import type { FlexTreeCell } from './FlexRoutingPlanner';
import {
    branchCandidatesFor,
    type FlexBranchCandidate,
    getFlexArrowOutputs,
} from './FlexRoutingPlanner';
import type { FlexArrowState, GridPoint } from './types';

export interface FlexNetworkIntent {
    /** Marker/source cell, encoded as x,y. */
    id: string;
    source: GridPoint;
    /** First cell after the source arrow, or source itself for an empty marker. */
    start: GridPoint;
    /** The separate arrow cell that feeds the marker. */
    end: GridPoint;
    /** Actual marker destination; this cell may be occupied but is never written. */
    marker: GridPoint;
    /** Exact feeder-arrow state chosen by the planner. */
    endArrow: FlexArrowState;
}

export interface FlexNetworkSearchResult {
    complete: boolean;
    results: BranchResult[];
    /** Only writes that differ from the live board, with shared cells deduplicated. */
    steps: PathStep[];
    failedIntent?: FlexNetworkIntent;
}

interface PreparedCandidate {
    candidate: FlexBranchCandidate;
    reservations: Map<string, PathStep>;
}

const pointKey = (point: GridPoint): string => `${point.x},${point.y}`;
const sameState = (
    a: FlexArrowState | PathStep,
    b: FlexArrowState | PathStep,
): boolean =>
    a.type === b.type && a.rotation === b.rotation && a.flipped === b.flipped;

/**
 * Rebuilds the staged network from its connection intents on every run. Unlike
 * BranchRouteSearchTask, this task does not take the previous staged layout as
 * immutable reservations: prior staged paths are discarded and recreated, so
 * the route order and branch tree can change substantially between attempts.
 *
 * It still protects live board arrows (except legal endpoints / known source
 * trees), and only permits intersections inside the same source network when
 * arrow states are compatible. Branch candidates use the game's real arrow
 * relation table via branchCandidatesFor.
 */
export class FlexGlobalNetworkSearchTask
    implements ITask<FlexNetworkSearchResult>
{
    public isCanceled = false;
    public stepBatchSize = 32;

    private readonly gameMap: GameMap;
    private readonly intents: FlexNetworkIntent[];
    private readonly baseTrees: Map<string, FlexTreeCell[]>;
    private readonly blockedCells: ReadonlySet<string>;
    private readonly getLiveArrowState: (
        point: GridPoint,
    ) => FlexArrowState | null;
    private readonly variation: number;

    private readonly trees = new Map<string, Map<string, FlexTreeCell>>();
    private readonly baseTreeKeys = new Map<string, Set<string>>();
    private readonly roots = new Map<string, GridPoint>();
    private readonly reservations = new Map<string, PathStep>();
    private readonly routeWrites = new Map<string, PathStep>();
    private readonly routes: BranchResult[] = [];
    private readonly requestOrder: FlexNetworkIntent[];
    private activeIntent: FlexNetworkIntent | null = null;
    private candidates: PreparedCandidate[] = [];
    private candidateIndex = 0;
    private currentPathTask: PathFindingTask | null = null;
    private currentCandidate: PreparedCandidate | null = null;
    private bestCandidate: {
        candidate: PreparedCandidate;
        steps: PathStep[];
        score: number;
    } | null = null;
    private candidatesTried = 0;
    // A globally valid layout may need a less local junction than the first
    // few nearest cells, especially when two long routes overlap.
    private readonly maxCandidatesPerIntent = 96;
    private routeIndex = 0;
    private result: FlexNetworkSearchResult | null = null;
    private done = false;

    public constructor(
        gameMap: GameMap,
        intents: readonly FlexNetworkIntent[],
        baseTrees: ReadonlyMap<string, readonly FlexTreeCell[]>,
        blockedCells: ReadonlySet<string>,
        getLiveArrowState: (point: GridPoint) => FlexArrowState | null,
        variation = 0,
    ) {
        this.gameMap = gameMap;
        this.intents = intents.map((intent) => ({
            ...intent,
            source: { ...intent.source },
            start: { ...intent.start },
            end: { ...intent.end },
            marker: { ...intent.marker },
            endArrow: { ...intent.endArrow },
        }));
        this.baseTrees = new Map(
            [...baseTrees].map(([key, cells]) => [
                key,
                cells.map((cell) => ({ ...cell })),
            ]),
        );
        this.blockedCells = blockedCells;
        this.getLiveArrowState = getLiveArrowState;
        this.variation = variation;

        for (const [sourceKey, cells] of this.baseTrees) {
            const tree = new Map<string, FlexTreeCell>();
            this.baseTreeKeys.set(sourceKey, new Set(cells.map(pointKey)));
            for (const cell of cells) {
                const key = pointKey(cell);
                tree.set(key, { ...cell });
                const live = this.getLiveArrowState(cell);
                if (live && sameState(live, cell))
                    this.reservations.set(key, { ...cell });
            }
            this.trees.set(sourceKey, tree);
        }

        const groups = new Map<string, FlexNetworkIntent[]>();
        for (const intent of this.intents) {
            if (!this.roots.has(intent.id))
                this.roots.set(intent.id, { ...intent.start });
            const list = groups.get(intent.id) ?? [];
            list.push(intent);
            groups.set(intent.id, list);
        }

        const stableHash = (value: string, seed: number): number => {
            // Deterministic, inexpensive permutation key. The seed is the outer
            // global-attempt number, so every retry can build a genuinely
            // different topology instead of cycling through four fixed orders.
            let hash = (0x811c9dc5 ^ Math.imul(seed + 1, 0x9e3779b1)) >>> 0;
            for (let i = 0; i < value.length; i += 1) {
                hash ^= value.charCodeAt(i);
                hash = Math.imul(hash, 0x01000193) >>> 0;
            }
            hash ^= hash >>> 16;
            hash = Math.imul(hash, 0x7feb352d) >>> 0;
            hash ^= hash >>> 15;
            return hash >>> 0;
        };
        const distance = (intent: FlexNetworkIntent) =>
            Math.abs(intent.end.x - intent.start.x) +
            Math.abs(intent.end.y - intent.start.y);
        const orderMode = ((variation % 8) + 8) % 8;
        const orderedGroups = [...groups.entries()].map(([id, list]) => {
            list.sort((a, b) => {
                if (orderMode === 0) return distance(b) - distance(a);
                if (orderMode === 1) return distance(a) - distance(b);
                const lexical = a.end.x - b.end.x || a.end.y - b.end.y;
                if (orderMode === 2) return lexical;
                if (orderMode === 3) return -lexical;
                const ah = stableHash(`${id}|${a.end.x},${a.end.y}`, variation);
                const bh = stableHash(`${id}|${b.end.x},${b.end.y}`, variation);
                return ah - bh;
            });
            return { id, list, span: Math.max(...list.map(distance)) };
        });
        orderedGroups.sort((a, b) => {
            if (orderMode === 0 || orderMode === 2) return b.span - a.span;
            if (orderMode === 1 || orderMode === 3) return a.span - b.span;
            return stableHash(a.id, variation) - stableHash(b.id, variation);
        });
        this.requestOrder = orderedGroups.flatMap((group) => group.list);
    }

    public step(maxStepsCount: number): boolean {
        if (this.done || this.isCanceled) return true;
        let consumed = 0;
        while (consumed < maxStepsCount && !this.done && !this.isCanceled) {
            if (this.activeIntent === null) {
                if (this.routeIndex >= this.requestOrder.length) {
                    this.finish(true);
                    break;
                }
                this.beginIntent(this.requestOrder[this.routeIndex]);
                if (this.activeIntent === null) continue;
            }

            if (this.currentPathTask) {
                const finished = this.currentPathTask.step(
                    Math.max(1, maxStepsCount - consumed),
                );
                consumed += Math.max(1, maxStepsCount - consumed);
                if (!finished) return false;

                const path = this.currentPathTask.getResult();
                this.currentPathTask = null;
                const completedCandidate = this.currentCandidate;
                this.currentCandidate = null;
                this.candidatesTried += 1;
                if (path && completedCandidate) {
                    // PathFindingTask already returns an efficient path for this
                    // junction. Accept the first viable junction and let the
                    // whole-network validation drive subsequent backtracking.
                    this.bestCandidate = {
                        candidate: completedCandidate,
                        steps: path,
                        score:
                            path.length +
                            completedCandidate.candidate.upgrades.length * 0.2,
                    };
                    if (!this.acceptBest()) {
                        this.finish(false, this.activeIntent);
                        break;
                    }
                } else {
                    this.candidateIndex += 1;
                    if (
                        this.candidateIndex >= this.candidates.length ||
                        this.candidatesTried >= this.maxCandidatesPerIntent
                    ) {
                        if (!this.acceptBest()) {
                            this.finish(false, this.activeIntent);
                            break;
                        }
                    }
                }
                continue;
            }

            if (
                this.candidateIndex >= this.candidates.length ||
                this.candidatesTried >= this.maxCandidatesPerIntent
            ) {
                if (!this.acceptBest()) this.finish(false, this.activeIntent);
                continue;
            }

            const prepared = this.candidates[this.candidateIndex];
            const candidate = prepared.candidate;
            if (
                candidate.start.x === this.activeIntent.end.x &&
                candidate.start.y === this.activeIntent.end.y
            ) {
                this.bestCandidate = {
                    candidate: prepared,
                    steps: [],
                    score: candidate.upgrades.length * 0.2,
                };
                if (!this.acceptBest()) this.finish(false, this.activeIntent);
                continue;
            }

            this.currentCandidate = prepared;
            const blocked = new Set(this.blockedCells);
            // Marker cells are sinks, not path cells. This remains true when a
            // marker happens to sit on an empty tile or over an existing arrow.
            for (const intent of this.intents) {
                blocked.add(pointKey(intent.marker));
                if (intent.id !== this.activeIntent.id)
                    blocked.add(pointKey(intent.end));
            }
            for (const [key] of this.reservations) {
                const owner = this.findTreeOwner(key);
                if (owner !== null && owner !== this.activeIntent.id)
                    blocked.add(key);
            }
            this.currentPathTask = new PathFindingTask(
                this.gameMap,
                candidate.start.x,
                candidate.start.y,
                this.activeIntent.end.x,
                this.activeIntent.end.y,
                prepared.reservations,
                blocked,
                this.variation,
            );
        }
        return this.done || this.isCanceled;
    }

    public getResult(): FlexNetworkSearchResult {
        return this.result ?? { complete: false, results: [], steps: [] };
    }

    private beginIntent(intent: FlexNetworkIntent): void {
        const markerKeys = new Set(
            this.intents.map((other) => pointKey(other.marker)),
        );
        // Neither a feeder nor a route root may occupy any marker. The marker
        // itself is only the sink coordinate, even when a live arrow already
        // occupies that cell.
        if (
            pointKey(intent.end) === pointKey(intent.marker) ||
            markerKeys.has(pointKey(intent.start))
        ) {
            this.finish(false, intent);
            return;
        }
        this.activeIntent = intent;
        this.candidateIndex = 0;
        this.candidatesTried = 0;
        this.bestCandidate = null;
        const tree =
            this.trees.get(intent.id) ?? new Map<string, FlexTreeCell>();
        this.trees.set(intent.id, tree);

        let candidates: FlexBranchCandidate[];
        if (tree.size === 0) {
            const liveStart = this.getLiveArrowState(intent.start);
            if (liveStart !== null) {
                candidates = [];
            } else {
                candidates = [{ start: { ...intent.start }, upgrades: [] }];
            }
        } else {
            const alreadyFeedsEnd = [...tree.values()].some((cell) =>
                getFlexArrowOutputs(
                    cell,
                    (point, rotation, flipped, forward, sideways) =>
                        getRelativePosition(
                            point.x,
                            point.y,
                            rotation,
                            flipped,
                            forward,
                            sideways,
                        ),
                ).some((output) => pointKey(output) === pointKey(intent.end)),
            );
            if (tree.has(pointKey(intent.end)) || alreadyFeedsEnd) {
                this.candidates = [
                    {
                        candidate: { start: { ...intent.end }, upgrades: [] },
                        reservations: new Map(this.reservations),
                    },
                ];
                this.candidateIndex = 0;
                this.candidatesTried = 0;
                this.bestCandidate = null;
                return;
            }
            const deps = {
                getArrowState: (point: GridPoint) => {
                    const owned = tree.get(pointKey(point));
                    return owned
                        ? {
                              type: owned.type,
                              rotation: owned.rotation,
                              flipped: owned.flipped,
                          }
                        : this.getLiveArrowState(point);
                },
                isStagedCell: (point: GridPoint) => tree.has(pointKey(point)),
                getRelativeCell: (
                    point: GridPoint,
                    rotation: number,
                    flipped: boolean,
                    forward: number,
                    sideways: number,
                ) =>
                    getRelativePosition(
                        point.x,
                        point.y,
                        rotation,
                        flipped,
                        forward,
                        sideways,
                    ),
            };
            // Destinations are sinks, not trunks. A destination arrow must not
            // become a branch junction (that would chain one endpoint through
            // another), nor may a branch start on a destination cell.
            // Occupancy still uses the full tree, so a destination can never be
            // overwritten as an empty cell; only its role as a junction is removed.
            const destinationKeys = new Set(
                this.intents
                    .filter((other) => other.id === intent.id)
                    .flatMap((other) => [
                        pointKey(other.end),
                        pointKey(other.marker),
                    ]),
            );
            const markerKeys = new Set(
                this.intents.map((other) => pointKey(other.marker)),
            );
            const trunk = [...tree.values()].filter(
                (cell) =>
                    !destinationKeys.has(pointKey(cell)) &&
                    !markerKeys.has(pointKey(cell)),
            );
            candidates = branchCandidatesFor(
                trunk,
                intent.end,
                deps,
                markerKeys,
            ).filter(
                (candidate) =>
                    !destinationKeys.has(pointKey(candidate.start)) &&
                    candidate.upgrades.every(
                        (upgrade) =>
                            !destinationKeys.has(pointKey(upgrade)) &&
                            !markerKeys.has(pointKey(upgrade)),
                    ),
            );
        }

        // Search different branch junctions on different full-network attempts.
        // This permits later retry passes to abandon a poor old trunk entirely.
        const unique = new Map<string, FlexBranchCandidate>();
        for (const candidate of candidates) {
            const key = `${pointKey(candidate.start)}|${candidate.upgrades.map((u) => `${u.x},${u.y}:${u.type}:${u.rotation}:${u.flipped ? 1 : 0}`).join(';')}`;
            if (!unique.has(key)) unique.set(key, candidate);
        }
        const ordered = [...unique.values()].sort((a, b) => {
            const da =
                Math.abs(a.start.x - intent.end.x) +
                Math.abs(a.start.y - intent.end.y);
            const db =
                Math.abs(b.start.x - intent.end.x) +
                Math.abs(b.start.y - intent.end.y);
            return da - db;
        });
        const offset =
            ordered.length === 0 ? 0 : (this.variation * 17) % ordered.length;
        const rotated = ordered.slice(offset).concat(ordered.slice(0, offset));
        this.candidates = rotated
            .slice(0, this.maxCandidatesPerIntent)
            .map((candidate) => {
                const candidateReservations = new Map(this.reservations);
                // Cells created during this global solve are soft reservations. A
                // later cable from the same source may replace their arrow type or
                // orientation. Only committed/base-tree cells stay fixed unless a
                // legal splitter-upgrade candidate explicitly changes one.
                const fixedKeys =
                    this.baseTreeKeys.get(intent.id) ?? new Set<string>();
                for (const key of this.trees.get(intent.id)?.keys() ?? []) {
                    if (!fixedKeys.has(key)) candidateReservations.delete(key);
                }
                for (const upgrade of candidate.upgrades) {
                    candidateReservations.set(pointKey(upgrade), {
                        ...upgrade,
                    });
                }
                return { candidate, reservations: candidateReservations };
            });

        if (this.candidates.length === 0) {
            this.activeIntent = intent;
            this.acceptBest();
        }
    }

    private acceptBest(): boolean {
        const intent = this.activeIntent;
        const best = this.bestCandidate;
        if (!intent || !best) return false;

        // Pathfinding honors the reservation overlay. Assert compatibility again
        // before mutating shared state because splitters intentionally replace one
        // existing arrow with a different state.
        const tree = this.trees.get(intent.id)!;

        // A route ends at a dedicated feeder cell, never at the marker itself.
        // Pathfinding omits that terminal cell from its path, so write only the
        // exact arrow selected by the planner. Never synthesize a terminal arrow
        // at a marker when a feeder could not be found.
        const markerKeys = new Set(
            this.intents.map((other) => pointKey(other.marker)),
        );
        if (markerKeys.has(pointKey(intent.end))) return false;
        const steps = [...best.steps];
        if (this.destinationNeedsArrow(intent, steps)) {
            steps.push({
                x: intent.end.x,
                y: intent.end.y,
                type: intent.endArrow.type,
                rotation: intent.endArrow.rotation,
                flipped: intent.endArrow.flipped,
            });
        }
        if (
            steps.some((step) => markerKeys.has(pointKey(step))) ||
            best.candidate.candidate.upgrades.some((upgrade) =>
                markerKeys.has(pointKey(upgrade)),
            )
        ) {
            return false;
        }
        if (
            steps.some(
                (step) =>
                    pointKey(step) === pointKey(intent.end) &&
                    !sameState(step, intent.endArrow),
            )
        ) {
            return false;
        }

        for (const step of steps) {
            // Compare against this candidate's reservation overlay: its splitter
            // upgrade may intentionally have changed the old junction state.
            const previous = best.candidate.reservations.get(pointKey(step));
            if (previous && !sameState(previous, step)) return false;
        }
        for (const upgrade of best.candidate.candidate.upgrades) {
            const old = tree.get(pointKey(upgrade));
            if (!old) return false;
        }

        // Splitter upgrades override the old cell's state while preserving all
        // previous outputs; this is the crucial overlap/reform operation.
        for (const upgrade of best.candidate.candidate.upgrades) {
            const key = pointKey(upgrade);
            tree.set(key, { ...upgrade });
            this.reservations.set(key, { ...upgrade });
            const live = this.getLiveArrowState(upgrade);
            if (!live || !sameState(live, upgrade))
                this.routeWrites.set(key, { ...upgrade });
            else this.routeWrites.delete(key);
        }
        for (const step of steps) {
            const key = pointKey(step);
            // The newest route owns the final arrow at a shared staged cell.
            // Global reachability validation decides whether this rewrite still
            // leaves every earlier destination connected.
            this.reservations.set(key, { ...step });
            tree.set(key, { ...step });
            const live = this.getLiveArrowState(step);
            if (!live || !sameState(live, step))
                this.routeWrites.set(key, { ...step });
            else this.routeWrites.delete(key);
        }

        // Remove stale cable fragments made unreachable by an overlap rewrite.
        // They must not remain candidate branch points or leak into the final
        // preview as orphan arrows. If a committed cell was temporarily upgraded,
        // restore its original committed state when it is no longer in the tree.
        this.pruneDisconnectedCells(intent.id);

        this.routes.push({
            id: intent.id,
            steps: steps.map((step) => ({ ...step })),
            upgrades: best.candidate.candidate.upgrades.map((step) => ({
                ...step,
            })),
        });
        this.routeIndex += 1;
        this.activeIntent = null;
        this.candidates = [];
        this.candidateIndex = 0;
        this.candidatesTried = 0;
        this.bestCandidate = null;
        this.currentCandidate = null;
        return true;
    }

    /** True when the exact planned feeder arrow still needs to be written. */
    private destinationNeedsArrow(
        intent: FlexNetworkIntent,
        steps: readonly PathStep[],
    ): boolean {
        const key = pointKey(intent.end);
        const pathStep = steps.find((step) => pointKey(step) === key);
        if (pathStep) return !sameState(pathStep, intent.endArrow);

        const live = this.getLiveArrowState(intent.end);
        if (live && sameState(live, intent.endArrow)) return false;
        const reserved = this.reservations.get(key);
        if (reserved && sameState(reserved, intent.endArrow)) return false;

        // A staged cell owned by this same source can be reformed. Live/base
        // arrows that differ are not silently overwritten; candidate reservation
        // checks below will reject those conflicts.
        const owner = this.findTreeOwner(key);
        const mutableStagedCell =
            owner === intent.id &&
            !(this.baseTreeKeys.get(intent.id)?.has(key) ?? false);
        if (live && !mutableStagedCell) return false;
        if (reserved && !mutableStagedCell) return false;
        return true;
    }

    private pruneDisconnectedCells(sourceId: string): void {
        const tree = this.trees.get(sourceId);
        const root = this.roots.get(sourceId);
        if (!tree || tree.size === 0 || !root || !tree.has(pointKey(root)))
            return;

        const reachable = new Set<string>();
        const queue: GridPoint[] = [{ ...root }];
        while (queue.length > 0) {
            const point = queue.shift()!;
            const key = pointKey(point);
            if (reachable.has(key)) continue;
            const cell = tree.get(key);
            if (!cell) continue;
            reachable.add(key);
            for (const output of getFlexArrowOutputs(
                cell,
                (origin, rotation, flipped, forward, sideways) =>
                    getRelativePosition(
                        origin.x,
                        origin.y,
                        rotation,
                        flipped,
                        forward,
                        sideways,
                    ),
            )) {
                const outputKey = pointKey(output);
                if (tree.has(outputKey) && !reachable.has(outputKey))
                    queue.push(output);
            }
        }

        const baseCells = this.baseTrees.get(sourceId) ?? [];
        const baseByKey = new Map(
            baseCells.map((cell) => [pointKey(cell), cell] as const),
        );
        for (const key of [...tree.keys()]) {
            if (reachable.has(key)) continue;
            tree.delete(key);
            const originalBase = baseByKey.get(key);
            if (originalBase) {
                // A disused committed junction is not part of this route's active
                // tree anymore; retain its original live state and do not stage an
                // orphan splitter upgrade on it.
                this.reservations.set(key, { ...originalBase });
                this.routeWrites.delete(key);
            } else if (
                this.findTreeOwner(key) === null &&
                !this.isBaseTreeCell(key)
            ) {
                this.reservations.delete(key);
                this.routeWrites.delete(key);
            }
        }

        for (const [key, cell] of tree) {
            const finalState =
                this.routeWrites.get(key) ?? this.reservations.get(key);
            if (finalState) tree.set(key, { ...finalState });
            else tree.set(key, { ...cell });
        }
    }

    private isBaseTreeCell(key: string): boolean {
        for (const keys of this.baseTreeKeys.values())
            if (keys.has(key)) return true;
        return false;
    }

    private normalizeRoutes(): BranchResult[] {
        return this.routes.map((route) => {
            const tree = this.trees.get(route.id);
            if (!tree) return { id: route.id, steps: [], upgrades: [] };
            const normalize = (step: PathStep): PathStep | null => {
                const final = tree.get(pointKey(step));
                return final ? { ...final } : null;
            };
            return {
                id: route.id,
                // Route metadata must reflect the final shared-network layout,
                // not a path snapshot that was superseded by a later cable.
                steps: route.steps
                    .map(normalize)
                    .filter((step): step is PathStep => step !== null),
                upgrades: route.upgrades
                    .map(normalize)
                    .filter((step): step is PathStep => step !== null),
            };
        });
    }

    private findTreeOwner(key: string): string | null {
        for (const [source, tree] of this.trees) {
            if (tree.has(key)) return source;
        }
        return null;
    }

    private finish(complete: boolean, failedIntent?: FlexNetworkIntent): void {
        const steps = [...this.routeWrites.values()].map((step) => ({
            ...step,
        }));
        this.result = {
            complete,
            results: this.normalizeRoutes(),
            steps,
            ...(failedIntent ? { failedIntent } : {}),
        };
        this.done = true;
    }
}
