import type { ArrowData } from '@logic-arrows/game-logic/arrow-data';
import type { Game } from '@logic-arrows/game-logic/game';
import type { GameHistory } from '@logic-arrows/game-logic/game-history';
import type { KeyboardHandler } from '@logic-arrows/input/keyboard-handler';
import type { MouseHandler } from '@logic-arrows/input/mouse-handler';
import type { PlayerArrowActions } from '@logic-arrows/player/player-arrow-actions';
import type { PlayerControls } from '@logic-arrows/player/player-controls';
import type { PlayerMapAction } from '@logic-arrows/player/player-map-action';
import type { GraphDLC } from 'src/core/GraphDLC';
import type { PatchLoader } from 'src/core/PatchLoader';
import type { BranchResult } from 'src/core/path_finder/BranchRouteSearchTask';
import {
    ARROW_CONFIGS,
    type ArrowConfig,
    type PathStep,
} from 'src/core/path_finder/types';
import { ArrowType } from 'src/core/utils/ArrowType';
import { getRelativePosition } from 'src/core/utils/getRelativePosition';
import type { IPatcher } from '../../Patcher';
import { FlexRoutingTrigger, PathBuildingTrigger } from '..';
import {
    FlexGlobalNetworkSearchTask,
    type FlexNetworkIntent,
} from './FlexGlobalNetworkSearchTask';
import type { FlexTreeCell } from './FlexRoutingPlanner';
import {
    buildFlexPlacementPlan,
    canApplyFlexSteps,
    type FlexPlanDeps,
} from './FlexRoutingPlanner';
import { type FlexRotation, flexRoutingState } from './FlexRoutingState';
import { getFlexDragFrameAction } from './FlexDragFramePolicy';
import {
    isFlexRoutingModeActive as checkFlexRoutingModeActive,
    shouldDispatchFlexKey,
} from './FlexKeyboardMode';
import { validateFlexSignalRoutes } from './FlexSignalValidator';
import type {
    FlexArrowState,
    FlexGhost,
    FlexPreviewState,
    GridPoint,
    PathData,
} from './types';

const FLEX_SEARCH_KEY = 'flex-route-preview';
/** Ignore the click that follows a drop, so dropping does not toggle a mark. */
const FLEX_DROP_CLICK_SUPPRESS_MS = 120;
/** Presses that travel further than this are pans, not mark clicks. */
const FLEX_CLICK_MAX_DRIFT_PX = 6;
const EMPTY_FLEX_PREVIEW: FlexPreviewState = {
    status: 'idle',
    ghosts: [],
    steps: [],
};

function flexPointKey(point: GridPoint): string {
    return `${point.x},${point.y}`;
}

function parseFlexPointKey(key: unknown): GridPoint | null {
    if (typeof key !== 'string') return null;
    const parts = key.split(',');
    if (parts.length !== 2) return null;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
    return { x, y };
}

function sameFlexArrowState(
    a: FlexArrowState | null,
    b: FlexArrowState | null,
): boolean {
    if (a === null || b === null) return a === b;
    return (
        a.type === b.type &&
        a.rotation === b.rotation &&
        a.flipped === b.flipped
    );
}

const FLEX_ROTATION_KEYS: Record<string, FlexRotation | undefined> = {
    KeyW: 0,
    KeyD: 1,
    KeyS: 2,
    KeyA: 3,
};

/** The keyboard/UI trigger and routing state must agree before flex mode may
 * consume input. This keeps the capture-phase shortcut handler from stealing
 * the game's normal rotate/flip keys when B mode is off. */
function isFlexRoutingModeActive(): boolean {
    return checkFlexRoutingModeActive(
        flexRoutingState.isEnabled(),
        FlexRoutingTrigger.value,
    );
}

const ROUTABLE_ARROWS = ARROW_CONFIGS as unknown as Partial<
    Record<number, ArrowConfig>
>;

interface FlexDragState {
    grab: GridPoint;
}

interface FlexSearchResult {
    requestId: number;
    signature: string;
    status: 'ok' | 'failed';
    /** Every cell written by the plan: routes plus splitter upgrades. */
    steps: PathStep[];
    results: BranchResult[];
}

interface PrivatePlayerControls {
    readonly mouseHandler: MouseHandler;
    readonly keyboardHandler: KeyboardHandler;
    readonly arrowActions: PlayerArrowActions;
    readonly game: Game & {
        pathData: PathData | null;
        flexPreview: FlexPreviewState;
        screenUpdated?: boolean;
    };
    readonly history: GameHistory | null;
    getPositionByMousePosition(): [x: number, y: number];
}

export const PatchPlayerControls: IPatcher = (
    patchLoader: PatchLoader,
    graphDLC: GraphDLC,
) => {
    const _ArrowData = patchLoader.getDefinition<typeof ArrowData>('ArrowData');
    let isRightMouseDown = false;
    let isLeftMouseDown = false;
    let leftPressClient: { x: number; y: number } | null = null;

    document.addEventListener(
        'mousedown',
        (event: MouseEvent) => {
            if (event.button === 0) {
                isLeftMouseDown = true;
                leftPressClient = { x: event.clientX, y: event.clientY };
            }
            if (event.button === 2) {
                event.preventDefault();
                isRightMouseDown = true;
            }
        },
        true,
    );
    document.addEventListener(
        'mouseup',
        (event: MouseEvent) => {
            if (event.button === 0) isLeftMouseDown = false;
            if (event.button === 2) {
                event.preventDefault();
                isRightMouseDown = false;
            }
        },
        true,
    );
    document.addEventListener(
        'contextmenu',
        (event) => event.preventDefault(),
        true,
    );

    // Register before the game constructs PlayerControls, so flex shortcuts
    // (especially Space) run before native canvas/pause handlers. Space is
    // explicitly consumed here as well, even if the instance handler decides
    // there is no route ready to confirm; otherwise the game pauses instead.
    let activeFlexKeyHandler: ((event: KeyboardEvent) => void) | null = null;
    window.addEventListener(
        'keydown',
        (event: KeyboardEvent) => {
            const target = event.target;
            const isEditable =
                target instanceof HTMLElement &&
                (target.isContentEditable ||
                    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
            const flexModeActive = isFlexRoutingModeActive();
            if (flexModeActive && event.code === 'Space' && !isEditable) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }

            // Outside B mode, do not run the flex key handler at all for normal
            // keys. This guarantees W/A/S/D/F reach KeyboardHandler unchanged
            // for standard arrow rotation and flipping.
            if (shouldDispatchFlexKey(event.code, flexModeActive)) {
                activeFlexKeyHandler?.(event);
            }
        },
        true,
    );

    patchLoader.addDefinitionPatch(
        'PlayerControls',
        (_module: typeof PlayerControls) => {
            const _PlayerMapAction =
                patchLoader.getDefinition<typeof PlayerMapAction>(
                    'PlayerMapAction',
                );

            return class PlayerControls extends _module {
                private pathData: PathData | null = null;
                private isPathCancelled = false;
                private readonly flexCanvas: HTMLCanvasElement | null;
                private readonly onFlexKeyDown: (event: KeyboardEvent) => void;
                private readonly onFlexBoardClick: (event: MouseEvent) => void;
                private readonly oldLeftClickCallback: () => void;

                private flexDrag: FlexDragState | null = null;
                /** A released drag stays preview-only until Space confirms it. */
                private flexDropPending = false;
                private flexDropGrab: GridPoint | null = null;
                private flexDropCursor: GridPoint | null = null;
                private flexConfirmRequested = false;
                private flexGhosts: FlexGhost[] = [];
                private flexRequestId = 0;
                private flexSearchSignature: string | null = null;
                private flexResult: FlexSearchResult | null = null;
                private flexSuppressClickUntil = 0;

                /** Writes that are staged until Enter commits the whole preview. */
                private readonly stagedFlexSteps = new Map<string, PathStep>();
                /** Original board state for each staged cell, used to catch stale previews. */
                private readonly stagedFlexBaseStates = new Map<
                    string,
                    FlexArrowState | null
                >();
                private readonly stagedFlexGhosts = new Map<
                    string,
                    FlexGhost
                >();
                private readonly stagedFlexTrees = new Map<
                    string,
                    Map<string, FlexTreeCell>
                >();

                /**
                 * Hit-test the actual game board rather than relying on the exact
                 * event target being the canvas. Some render layouts deliver clicks
                 * to a wrapper/overlay even though the pointer is over the canvas.
                 */
                private isFlexBoardClick(event: MouseEvent): boolean {
                    const path = event.composedPath();
                    if (this.flexCanvas && path.includes(this.flexCanvas))
                        return true;

                    const canvases = Array.from(
                        document.querySelectorAll('canvas'),
                    );
                    if (
                        this.flexCanvas &&
                        !canvases.includes(this.flexCanvas)
                    ) {
                        canvases.push(this.flexCanvas);
                    }
                    return canvases.some((canvas) => {
                        const rect = canvas.getBoundingClientRect();
                        return (
                            rect.width > 0 &&
                            rect.height > 0 &&
                            event.clientX >= rect.left &&
                            event.clientX < rect.right &&
                            event.clientY >= rect.top &&
                            event.clientY < rect.bottom
                        );
                    });
                }

                public constructor(...args: any[]) {
                    super(...args);

                    const controls = this as unknown as PrivatePlayerControls;
                    this.flexCanvas =
                        args[0] instanceof HTMLCanvasElement ? args[0] : null;

                    this.oldLeftClickCallback =
                        controls.mouseHandler.leftClickCallback;
                    controls.mouseHandler.leftClickCallback = () => {
                        if (isFlexRoutingModeActive()) return;
                        this.oldLeftClickCallback();
                    };

                    this.onFlexBoardClick = (event: MouseEvent) => {
                        if (!isFlexRoutingModeActive() || event.button !== 0)
                            return;
                        if (!this.isFlexBoardClick(event)) return;
                        event.preventDefault();
                        event.stopImmediatePropagation();

                        if (event.ctrlKey || event.metaKey) return;
                        if (performance.now() < this.flexSuppressClickUntil)
                            return;
                        if (
                            leftPressClient !== null &&
                            Math.hypot(
                                event.clientX - leftPressClient.x,
                                event.clientY - leftPressClient.y,
                            ) > FLEX_CLICK_MAX_DRIFT_PX
                        )
                            return;

                        const [x, y] = controls.getPositionByMousePosition();
                        flexRoutingState.toggleMark({ x, y });
                        controls.game.screenUpdated = true;
                    };
                    // Capture at window level so other document capture handlers
                    // cannot consume the click before flex marking sees it.
                    window.addEventListener(
                        'click',
                        this.onFlexBoardClick,
                        true,
                    );

                    this.onFlexKeyDown = (event: KeyboardEvent) =>
                        this.handleFlexKeyDown(event);
                    activeFlexKeyHandler = this.onFlexKeyDown;
                }

                public update(): void {
                    this.syncFlexRoutingMode();
                    const controls = this as unknown as PrivatePlayerControls;
                    const taskKey = 'player-drag-path';

                    this.isPathCancelled =
                        this.isPathCancelled ||
                        (isRightMouseDown && isLeftMouseDown);

                    if (this.isPathCancelled) {
                        if (isRightMouseDown && this.pathData) {
                            graphDLC.pathFinder.cancelPathSearch(taskKey);
                            this.pathData = null;
                            controls.game.pathData = null;
                            PathBuildingTrigger.value = false;
                        } else if (!isRightMouseDown) {
                            this.isPathCancelled = false;
                        }
                    } else if (isFlexRoutingModeActive()) {
                        controls.mouseHandler.setUiInteraction(false);
                        if (this.updateFlexFrame()) {
                            return;
                        }
                    } else if (isRightMouseDown) {
                        controls.mouseHandler.setUiInteraction(true);
                        this.isPathCancelled = false;
                        const [x, y] = controls.getPositionByMousePosition();
                        const selectedArrow =
                            controls.arrowActions.getActiveArrowType();
                        const rotation =
                            controls.game.selectedMap.getRotationState();
                        const flipped = (controls.game.selectedMap as any)
                            .flipState;

                        if (!this.pathData) {
                            this.pathData = {
                                startPathX: x,
                                startPathY: y,
                                endPathX: x,
                                endPathY: y,
                                lastGraphUpdate: 0,
                                path: [],
                                arrowType: selectedArrow,
                                rotation,
                                flip: flipped,
                            };
                            PathBuildingTrigger.value = true;
                        }

                        const path = this.pathData;
                        const graphUpdate =
                            controls.game.gameMap.graph.lastUpdate;
                        if (
                            path.endPathX !== x ||
                            path.endPathY !== y ||
                            path.arrowType !== selectedArrow ||
                            path.rotation !== rotation ||
                            path.flip !== flipped ||
                            path.lastGraphUpdate !== graphUpdate
                        ) {
                            path.endPathX = x;
                            path.endPathY = y;
                            path.arrowType = selectedArrow;
                            path.rotation = rotation;
                            path.flip = flipped;
                            path.lastGraphUpdate = graphUpdate;
                            graphDLC.pathFinder.cancelPathSearch(taskKey);

                            if (
                                path.startPathX === x &&
                                path.startPathY === y
                            ) {
                                path.path = [];
                            } else if (selectedArrow === -1) {
                                graphDLC.pathFinder.findPathAsync(
                                    taskKey,
                                    controls.game.gameMap,
                                    path.startPathX,
                                    path.startPathY,
                                    x,
                                    y,
                                    (newPath) => {
                                        if (this.pathData) {
                                            this.pathData.path = newPath ?? [];
                                            controls.game.pathData =
                                                this.pathData;
                                        }
                                    },
                                );
                            } else {
                                graphDLC.pathFinder.findLinearPathAsync(
                                    taskKey,
                                    path.startPathX,
                                    path.startPathY,
                                    x,
                                    y,
                                    selectedArrow,
                                    rotation,
                                    flipped,
                                    (newPath) => {
                                        if (this.pathData) {
                                            this.pathData.path = newPath ?? [];
                                            controls.game.pathData =
                                                this.pathData;
                                        }
                                    },
                                );
                            }
                        }
                    } else if (this.pathData) {
                        const completedPath =
                            graphDLC.pathFinder.forceCompletePath(taskKey) ??
                            this.pathData.path;
                        this.commitPath(completedPath);
                    }

                    super.update();
                }

                /**
                 * Drives Ctrl-drag from a selected mark. Returns true when the
                 * frame belongs to the flex drag, so native camera panning and
                 * arrow placement stay off while dragging.
                 */
                private updateFlexFrame(): boolean {
                    const controls = this as unknown as PrivatePlayerControls;
                    const isDragGesture =
                        controls.keyboardHandler.getCtrlPressed() &&
                        controls.mouseHandler.getMousePressed();
                    const [x, y] = controls.getPositionByMousePosition();
                    const cursor = { x, y };
                    const action = getFlexDragFrameAction(
                        this.flexDrag !== null,
                        this.flexDropPending,
                        isDragGesture,
                        flexRoutingState.isSelected(cursor),
                    );

                    switch (action) {
                        case 'start-drag':
                            this.beginFlexDrag(cursor);
                            return true;
                        case 'update-drag':
                            this.refreshFlexPreview(cursor);
                            return true;
                        case 'drop-drag':
                            return this.updateFlexDrop(cursor);
                        case 'keep-pending':
                            // Crucially, don't return true here. A released route
                            // is only a preview awaiting Space, not a live drag;
                            // allowing the regular update loop keeps zoom and other
                            // controls responsive and lets selection transforms
                            // continue to affect the candidate. Another Ctrl-drag
                            // from a selected mark can replace it before Space.
                            this.tryConfirmFlexDrop();
                            return false;
                        case 'idle':
                        default:
                            return false;
                    }
                }

                private beginFlexDrag(cursor: GridPoint): void {
                    const controls = this as unknown as PrivatePlayerControls;
                    this.flexDrag = { grab: { ...cursor } };
                    this.flexDropPending = false;
                    this.flexDropGrab = null;
                    this.flexDropCursor = null;
                    this.flexConfirmRequested = false;
                    this.flexSearchSignature = null;
                    this.flexResult = null;
                    controls.mouseHandler.setUiInteraction(false);
                    this.refreshFlexPreview(cursor);
                }

                /**
                 * Recomputes the plan and starts a route search whenever the
                 * cursor, transform, selection or map revision changes. Results
                 * from superseded searches are ignored.
                 */
                private refreshFlexPreview(cursor: GridPoint): void {
                    const grab = this.flexDrag?.grab ?? this.flexDropGrab;
                    if (!grab) return;

                    const signature = this.getFlexSignature(grab, cursor);
                    if (signature === this.flexSearchSignature) return;
                    this.flexSearchSignature = signature;

                    const requestId = ++this.flexRequestId;
                    this.flexResult = null;
                    graphDLC.pathFinder.cancelPathSearch(FLEX_SEARCH_KEY);

                    const plan = buildFlexPlacementPlan(
                        flexRoutingState.getSelectedMarks(),
                        grab,
                        cursor,
                        flexRoutingState.getTransform(),
                        this.createFlexPlanDeps(),
                    );

                    // All staged destinations participate in every solve. This is
                    // the key difference from the old incremental router: prior
                    // preview cables are not held as fixed paths, they are intents
                    // that must be rebuilt together with the newly dragged cables.
                    const ghostsByEndpoint = new Map<string, FlexGhost>();
                    // A source can feed several destinations. Key each staged
                    // connection by both its source and marker instead of source
                    // alone; otherwise adding a second route from the same input
                    // silently deletes the first route and its saved marker.
                    const ghostKey = (ghost: FlexGhost) =>
                        `${flexPointKey(ghost.source ?? ghost.marker)}|${flexPointKey(ghost.marker)}`;
                    for (const ghost of this.stagedFlexGhosts.values()) {
                        ghostsByEndpoint.set(ghostKey(ghost), {
                            ...ghost,
                            blocked: false,
                        });
                    }
                    for (const ghost of plan.ghosts) {
                        // A missing/blocked feeder must stay blocked. Converting it
                        // to a valid endpoint used to make the solver place a
                        // fallback terminal arrow directly on the marker.
                        ghostsByEndpoint.set(ghostKey(ghost), {
                            ...ghost,
                        });
                    }
                    this.flexGhosts = [...ghostsByEndpoint.values()];

                    const controls = this as unknown as PrivatePlayerControls;
                    const baseTrees = new Map<string, FlexTreeCell[]>();
                    const sourcePoints = new Map<string, GridPoint>();
                    for (const ghost of this.flexGhosts) {
                        if (ghost.source)
                            sourcePoints.set(
                                flexPointKey(ghost.source),
                                ghost.source,
                            );
                    }
                    for (const [sourceKey, source] of sourcePoints) {
                        const committedTree = flexRoutingState.getTree(source);
                        if (committedTree.length === 0) continue;
                        const intact = committedTree.every((cell) => {
                            const live = this.getLiveFlexArrowState(cell);
                            return (
                                live !== null && sameFlexArrowState(live, cell)
                            );
                        });
                        if (intact) {
                            baseTrees.set(sourceKey, committedTree);
                        } else {
                            flexRoutingState.forgetTree(source);
                        }
                    }

                    const intents: FlexNetworkIntent[] = [];
                    let invalidStart = false;
                    let expectedIntentCount = 0;
                    for (const ghost of this.flexGhosts) {
                        if (!ghost.source || ghost.blocked || !ghost.arrowState) {
                            invalidStart = true;
                            ghost.blocked = true;
                            continue;
                        }
                        const source = { ...ghost.source };
                        const sourceKey = flexPointKey(source);
                        expectedIntentCount += 1;
                        const liveState = this.getLiveFlexArrowState(source);
                        const config = liveState
                            ? ROUTABLE_ARROWS[liveState.type]
                            : null;
                        const hasCommittedTree =
                            (baseTrees.get(sourceKey)?.length ?? 0) > 0;
                        let start: GridPoint;
                        if (liveState && config) {
                            start = getRelativePosition(
                                source.x,
                                source.y,
                                liveState.rotation,
                                liveState.flipped,
                                config.forward,
                                config.sideways,
                            );
                        } else if (!liveState || hasCommittedTree) {
                            // Empty marks are route roots in their own cell. If
                            // this input already owns a committed tree, its branch
                            // candidates supply the real start instead.
                            start = { ...source };
                        } else {
                            invalidStart = true;
                            ghost.blocked = true;
                            continue;
                        }
                        // A no-op drag of an empty mark onto itself is not a cable
                        // request. Avoid rejecting the accumulated network for it.
                        if (
                            !liveState &&
                            !hasCommittedTree &&
                            start.x === ghost.point.x &&
                            start.y === ghost.point.y
                        ) {
                            expectedIntentCount -= 1;
                            continue;
                        }
                        intents.push({
                            id: sourceKey,
                            source,
                            start,
                            end: { ...ghost.point },
                            marker: { ...ghost.marker },
                            // The arrow lives on the feeder cell and its output
                            // must land on the separate marker cell.
                            endArrow: { ...ghost.arrowState },
                        });
                    }

                    if (
                        invalidStart ||
                        intents.length !== expectedIntentCount
                    ) {
                        this.flexResult = {
                            requestId,
                            signature,
                            status: 'failed',
                            steps: [],
                            results: [],
                        };
                        this.publishFlexPreview('failed', []);
                        this.tryConfirmFlexDrop();
                        return;
                    }

                    if (intents.length === 0) {
                        this.flexResult = {
                            requestId,
                            signature,
                            status: 'ok',
                            steps: [],
                            results: [],
                        };
                        this.publishFlexPreview('ok', [], true);
                        this.tryConfirmFlexDrop();
                        return;
                    }

                    this.publishFlexPreview('pending', []);
                    const blockedCells = new Set<string>();
                    // A failed attempt's corridor ban is temporary. Keeping every
                    // failed cell banned forever can remove a cell that a later
                    // global topology actually needs, making a solvable circuit
                    // appear impossible. Recent bans diversify nearby retries;
                    // old bans expire so the solver can reconsider them.
                    const blockExpiresAt = new Map<string, number>();
                    const blockedCellLifetime = 8;
                    const protectedCells = new Set<string>();
                    for (const intent of intents) {
                        protectedCells.add(flexPointKey(intent.start));
                        protectedCells.add(flexPointKey(intent.end));
                        protectedCells.add(flexPointKey(intent.marker));
                    }
                    for (const tree of baseTrees.values()) {
                        for (const cell of tree)
                            protectedCells.add(flexPointKey(cell));
                    }

                    // Rebuild the entire network on every retry. One changed
                    // corridor is enough to make the next attempt explore another
                    // topology; the alternate route order and branch-junction
                    // windows let old cables reform instead of freezing in place.
                    // A route that breaks an earlier cable may require several completely
                    // different topologies before the network is valid. Keep the
                    // search bounded, but do not stop after only a handful of retries.
                    const maxGlobalAttempts = 160;
                    let attempt = 0;
                    const finishFailure = () => {
                        this.flexResult = {
                            requestId,
                            signature,
                            status: 'failed',
                            steps: [],
                            results: [],
                        };
                        this.publishFlexPreview('failed', []);
                        this.tryConfirmFlexDrop();
                    };

                    const addAlternativeBlock = (
                        routes: readonly BranchResult[],
                        preferredSource?: GridPoint,
                    ): boolean => {
                        const sourceKey = preferredSource
                            ? flexPointKey(preferredSource)
                            : null;
                        const preferredRoutes = sourceKey
                            ? routes.filter((route) => route.id === sourceKey)
                            : [];
                        const routePool = preferredRoutes.length
                            ? preferredRoutes
                            : [...routes].reverse();
                        const possible = new Map<string, PathStep>();
                        for (const route of routePool) {
                            for (const step of route.steps) {
                                const key = flexPointKey(step);
                                protectedCells.add(
                                    flexPointKey(route.steps[0] ?? step),
                                );
                                for (const upgrade of route.upgrades)
                                    protectedCells.add(flexPointKey(upgrade));
                                if (
                                    protectedCells.has(key) ||
                                    blockedCells.has(key)
                                )
                                    continue;
                                possible.set(key, step);
                            }
                        }
                        const cells = [...possible.values()];
                        if (cells.length === 0) return false;
                        const index =
                            (attempt * 11 +
                                (sourceKey ? sourceKey.length : 0)) %
                            cells.length;
                        const blockedKey = flexPointKey(cells[index]);
                        blockExpiresAt.set(
                            blockedKey,
                            attempt + blockedCellLifetime,
                        );
                        blockedCells.add(blockedKey);
                        return true;
                    };

                    const runGlobalSearch = (): void => {
                        if (requestId !== this.flexRequestId) return;
                        blockedCells.clear();
                        for (const [key, expiresAt] of blockExpiresAt) {
                            if (expiresAt < attempt) {
                                blockExpiresAt.delete(key);
                            } else {
                                blockedCells.add(key);
                            }
                        }
                        const task = new FlexGlobalNetworkSearchTask(
                            controls.game.gameMap,
                            intents,
                            baseTrees,
                            blockedCells,
                            (point) => this.getLiveFlexArrowState(point),
                            attempt,
                        );
                        graphDLC.pathFinder.scheduleTask(
                            FLEX_SEARCH_KEY,
                            task,
                            (searchResult) => {
                                if (
                                    requestId !== this.flexRequestId ||
                                    (this.flexDrag === null &&
                                        !this.flexDropPending)
                                )
                                    return;

                                const found = searchResult.results;
                                const validation = searchResult.complete
                                    ? validateFlexSignalRoutes(
                                          intents.map((intent) => ({
                                              id: intent.id,
                                              end: intent.end,
                                              marker: intent.marker,
                                          })),
                                          searchResult.steps,
                                          [],
                                          (point) =>
                                              this.getLiveFlexArrowState(point),
                                          20_000,
                                          [
                                              ...[...baseTrees.values()].flatMap(
                                                  (tree) =>
                                                      tree.map((cell) => ({
                                                          x: cell.x,
                                                          y: cell.y,
                                                      })),
                                              ),
                                              ...intents.map((intent) => intent.marker),
                                          ],
                                      )
                                    : {
                                          valid: false,
                                          reason: 'The global network could not route every destination',
                                      };

                                if (
                                    !searchResult.complete ||
                                    !validation.valid
                                ) {
                                    const addedBlock = addAlternativeBlock(
                                        found,
                                        validation.source,
                                    );
                                    attempt += 1;
                                    if (
                                        attempt < maxGlobalAttempts &&
                                        (addedBlock ||
                                            attempt < 8 ||
                                            found.length > 0)
                                    ) {
                                        runGlobalSearch();
                                        return;
                                    }
                                    finishFailure();
                                    return;
                                }

                                const status = 'ok';
                                this.flexResult = {
                                    requestId,
                                    signature,
                                    status,
                                    steps: searchResult.steps,
                                    results: found,
                                };
                                // Replace, rather than overlay, the old staged
                                // wires. Old corridors not used by this global
                                // solution must disappear from the preview.
                                this.publishFlexPreview(
                                    status,
                                    searchResult.steps,
                                    true,
                                );
                                this.tryConfirmFlexDrop();
                            },
                        );
                    };
                    runGlobalSearch();
                }

                /**
                 * Release freezes the final destination but does not stage it.
                 * Space is the explicit confirmation step; Enter remains the
                 * only action that writes the accumulated preview to the map.
                 */
                private updateFlexDrop(cursor: GridPoint): boolean {
                    if (!this.flexDrag) return false;

                    if (!this.flexDropPending) {
                        this.flexDropPending = true;
                        this.flexDropGrab = { ...this.flexDrag.grab };
                        this.flexDropCursor = { ...cursor };
                        this.flexDrag = null;
                    }

                    const dropCursor = this.flexDropCursor ?? cursor;
                    this.refreshFlexPreview(dropCursor);
                    this.tryConfirmFlexDrop();
                    return true;
                }

                /** Confirms a released drag after its final route search is ready. */
                private tryConfirmFlexDrop(): boolean {
                    if (
                        !this.flexConfirmRequested ||
                        !this.flexDropPending ||
                        !this.flexDropGrab ||
                        !this.flexDropCursor
                    )
                        return false;

                    // If Space was pressed during the physical drag, wait for
                    // mouseup; this avoids staging a route while its endpoint is
                    // still being moved by the user.
                    if (isLeftMouseDown) return false;

                    const grab = this.flexDropGrab;
                    const cursor = this.flexDropCursor;
                    const result = this.flexResult;
                    if (result === null) return false;

                    const isCurrent =
                        result.requestId === this.flexRequestId &&
                        result.signature ===
                            this.getFlexSignature(grab, cursor);
                    if (!isCurrent) {
                        this.refreshFlexPreview(cursor);
                        return false;
                    }

                    if (
                        result.status !== 'ok' ||
                        !this.stageFlexPlacement(result)
                    ) {
                        this.flexConfirmRequested = false;
                        const controls =
                            this as unknown as PrivatePlayerControls;
                        if (controls.game.flexPreview) {
                            controls.game.flexPreview = {
                                ...controls.game.flexPreview,
                                status: 'failed',
                            };
                            controls.game.screenUpdated = true;
                        }
                        return false;
                    }

                    this.flexSuppressClickUntil =
                        performance.now() + FLEX_DROP_CLICK_SUPPRESS_MS;
                    this.clearFlexDrag();
                    flexRoutingState.clearMarks();
                    const controls = this as unknown as PrivatePlayerControls;
                    controls.game.screenUpdated = true;
                    return true;
                }

                /**
                 * Adds the current successful drag to the accumulated preview
                 * without writing anything to the game map. This lets subsequent
                 * drags branch from earlier previewed cables.
                 */
                private stageFlexPlacement(result: FlexSearchResult): boolean {
                    const committedTreeCells = new Set<string>();
                    for (const { cells } of flexRoutingState.getAllTrees()) {
                        for (const cell of cells)
                            committedTreeCells.add(flexPointKey(cell));
                    }
                    if (
                        !canApplyFlexSteps(
                            result.steps,
                            (point) => this.getLiveFlexArrowState(point),
                            (point) =>
                                this.stagedFlexSteps.has(flexPointKey(point)) ||
                                committedTreeCells.has(flexPointKey(point)),
                        )
                    ) {
                        return false;
                    }

                    const markerKeys = new Set(
                        this.flexGhosts.map((ghost) => flexPointKey(ghost.marker)),
                    );
                    // A solver regression must never turn a marker into an arrow
                    // write. Existing arrows under markers are preserved by not
                    // including them in the staged write set.
                    if (
                        result.steps.some((step) => markerKeys.has(flexPointKey(step))) ||
                        this.flexGhosts.some(
                            (ghost) =>
                                ghost.arrowState !== null &&
                                flexPointKey(ghost.point) === flexPointKey(ghost.marker),
                        )
                    ) {
                        return false;
                    }

                    const routePoints = result.results.map((route) => ({
                        route,
                        point: parseFlexPointKey(route.id),
                    }));
                    if (routePoints.some(({ point }) => point === null))
                        return false;

                    const controls = this as unknown as PrivatePlayerControls;
                    const gameMap = controls.game.gameMap;
                    const writesByKey = new Map(
                        result.steps.map(
                            (step) => [flexPointKey(step), step] as const,
                        ),
                    );

                    // Snapshot original live states for new writes before replacing
                    // the staged map. Snapshots from prior attempts are retained,
                    // including cells no longer used by the final solution.
                    for (const step of result.steps) {
                        const key = flexPointKey(step);
                        if (this.stagedFlexBaseStates.has(key)) continue;
                        const arrow = gameMap.getArrow(step.x, step.y);
                        this.stagedFlexBaseStates.set(
                            key,
                            !arrow || arrow.type === ArrowType.EMPTY
                                ? null
                                : {
                                      type: arrow.type,
                                      rotation: arrow.rotation,
                                      flipped: arrow.flipped,
                                  },
                        );
                    }

                    // This is now a whole-network solution, not a delta. Replace
                    // stale staged corridors so cables omitted by the solver are
                    // actually removed from preview/commit rather than lingering.
                    this.stagedFlexSteps.clear();
                    for (const [key, step] of writesByKey) {
                        this.stagedFlexSteps.set(key, { ...step });
                    }

                    // Rebuild ownership trees from committed base trees plus the
                    // new full set of routes. No old staged-only cells survive.
                    this.stagedFlexTrees.clear();
                    for (const { route, point } of routePoints) {
                        if (point === null) return false;
                        const sourceKey = flexPointKey(point);
                        let tree = this.stagedFlexTrees.get(sourceKey);
                        if (!tree) {
                            tree = new Map(
                                flexRoutingState
                                    .getTree(point)
                                    .map((cell) => [
                                        flexPointKey(cell),
                                        { ...cell },
                                    ]),
                            );
                            this.stagedFlexTrees.set(sourceKey, tree);
                        }
                        for (const write of [
                            ...route.steps,
                            ...route.upgrades,
                        ]) {
                            tree.set(flexPointKey(write), { ...write });
                        }
                    }

                    // If a planned write changes a cell already tracked by a
                    // committed cable tree, keep the future saved tree's metadata
                    // synchronized with the final orientation/type.
                    for (const tree of this.stagedFlexTrees.values()) {
                        for (const [key, write] of writesByKey) {
                            if (tree.has(key)) tree.set(key, { ...write });
                        }
                    }

                    this.stagedFlexGhosts.clear();
                    for (const ghost of this.flexGhosts) {
                        this.stagedFlexGhosts.set(
                            `${flexPointKey(ghost.source ?? ghost.marker)}|${flexPointKey(ghost.marker)}`,
                            {
                                ...ghost,
                                point: { ...ghost.point },
                                marker: { ...ghost.marker },
                                source: ghost.source
                                    ? { ...ghost.source }
                                    : undefined,
                                arrowState: ghost.arrowState
                                    ? { ...ghost.arrowState }
                                    : null,
                            },
                        );
                    }
                    return true;
                }

                private clearFlexDrag(): void {
                    const controls = this as unknown as PrivatePlayerControls;
                    this.flexDrag = null;
                    this.flexDropPending = false;
                    this.flexDropGrab = null;
                    this.flexDropCursor = null;
                    this.flexConfirmRequested = false;
                    this.flexGhosts = [];
                    this.flexResult = null;
                    this.flexSearchSignature = null;
                    this.flexRequestId += 1;
                    graphDLC.pathFinder.cancelPathSearch(FLEX_SEARCH_KEY);
                    this.publishStagedFlexPreview();
                    controls.game.screenUpdated = true;
                }

                private publishFlexPreview(
                    status: FlexPreviewState['status'],
                    steps: PathStep[],
                    replaceStagedNetwork = false,
                ): void {
                    const controls = this as unknown as PrivatePlayerControls;
                    const combinedSteps = new Map<string, PathStep>(
                        replaceStagedNetwork ? [] : this.stagedFlexSteps,
                    );
                    for (const step of steps)
                        combinedSteps.set(flexPointKey(step), { ...step });

                    const combinedGhosts = new Map<string, FlexGhost>(
                        replaceStagedNetwork ? [] : this.stagedFlexGhosts,
                    );
                    for (const ghost of this.flexGhosts) {
                        combinedGhosts.set(flexPointKey(ghost.source ?? ghost.marker), ghost);
                    }

                    // A failed attempt leaves the previously accepted staged
                    // network visible; only a complete validated solve replaces it.
                    const displayStatus =
                        status === 'failed' && this.stagedFlexSteps.size > 0
                            ? 'ok'
                            : status;
                    controls.game.flexPreview = {
                        status: displayStatus,
                        ghosts: [...combinedGhosts.values()],
                        steps: [...combinedSteps.values()],
                    };
                    controls.game.screenUpdated = true;
                }

                private publishStagedFlexPreview(
                    status: 'ok' | 'failed' = 'ok',
                ): void {
                    const controls = this as unknown as PrivatePlayerControls;
                    const hasPreview =
                        this.stagedFlexSteps.size > 0 ||
                        this.stagedFlexGhosts.size > 0;
                    controls.game.flexPreview = hasPreview
                        ? {
                              status,
                              ghosts: [...this.stagedFlexGhosts.values()],
                              steps: [...this.stagedFlexSteps.values()],
                          }
                        : EMPTY_FLEX_PREVIEW;
                    controls.game.screenUpdated = true;
                }

                /** Discards the staged preview; no game-map arrows have been written yet. */
                private clearStagedFlexRouting(): void {
                    this.stagedFlexSteps.clear();
                    this.stagedFlexBaseStates.clear();
                    this.stagedFlexGhosts.clear();
                    this.stagedFlexTrees.clear();
                    this.publishStagedFlexPreview();
                }

                /** Writes all staged routes as one undoable action when Enter is pressed. */
                private commitStagedFlexRouting(): void {
                    const controls = this as unknown as PrivatePlayerControls;
                    if (this.stagedFlexSteps.size === 0) {
                        this.clearStagedFlexRouting();
                        return;
                    }

                    const gameMap = controls.game.gameMap;
                    for (const [key, originalState] of this
                        .stagedFlexBaseStates) {
                        const point = parseFlexPointKey(key);
                        if (point === null) continue;
                        const arrow = gameMap.getArrow(point.x, point.y);
                        const currentState: FlexArrowState | null =
                            !arrow || arrow.type === ArrowType.EMPTY
                                ? null
                                : {
                                      type: arrow.type,
                                      rotation: arrow.rotation,
                                      flipped: arrow.flipped,
                                  };
                        if (!sameFlexArrowState(currentState, originalState)) {
                            this.publishStagedFlexPreview('failed');
                            return;
                        }
                    }

                    this.writeSteps([...this.stagedFlexSteps.values()]);
                    for (const [sourceKey, tree] of this.stagedFlexTrees) {
                        const source = parseFlexPointKey(sourceKey);
                        if (source !== null) {
                            flexRoutingState.replaceTree(source, [
                                ...tree.values(),
                            ]);
                        }
                    }
                    this.clearStagedFlexRouting();
                }

                private getFlexSignature(
                    grab: GridPoint,
                    cursor: GridPoint,
                ): string {
                    const controls = this as unknown as PrivatePlayerControls;
                    const transform = flexRoutingState.getTransform();
                    return [
                        grab.x,
                        grab.y,
                        cursor.x,
                        cursor.y,
                        transform.rotation,
                        transform.flipped ? 1 : 0,
                        flexRoutingState.getSelectionKey(),
                        controls.game.gameMap.graph.lastUpdate,
                    ].join('|');
                }

                /**
                 * Finds the original input that owns a cell in a committed or
                 * staged cable tree. A marker placed over a preview arrow should
                 * add a destination to that input, not treat the preview arrow
                 * itself as a new movable input and drag it away from the tree.
                 */
                private findFlexTreeOwner(point: GridPoint): GridPoint | null {
                    const targetKey = flexPointKey(point);
                    const candidates = new Map<string, GridPoint>();
                    for (const { point: source } of flexRoutingState.getAllTrees()) {
                        candidates.set(flexPointKey(source), source);
                    }
                    for (const sourceKey of [...this.stagedFlexTrees.keys()]) {
                        const source = parseFlexPointKey(sourceKey);
                        if (source !== null) candidates.set(sourceKey, source);
                    }

                    for (const source of candidates.values()) {
                        const tree = this.validatedFlexTree(source);
                        if (tree.some((cell) => flexPointKey(cell) === targetKey)) {
                            return { ...source };
                        }
                    }
                    return null;
                }

                /**
                 * Cable cells an input owns, or none when the cable no longer
                 * matches the map (for example after an arrow was deleted).
                 */
                private validatedFlexTree(point: GridPoint): FlexTreeCell[] {
                    const sourceKey = flexPointKey(point);
                    const combined = new Map<string, FlexTreeCell>();
                    const globalTree = flexRoutingState.getTree(point);
                    const globalTreeKeys = new Set(
                        globalTree.map(flexPointKey),
                    );
                    for (const cell of globalTree) {
                        combined.set(flexPointKey(cell), cell);
                    }
                    for (const cell of this.stagedFlexTrees
                        .get(sourceKey)
                        ?.values() ?? []) {
                        combined.set(flexPointKey(cell), cell);
                    }

                    // A staged write may replace a cell belonging to a route
                    // committed in an earlier flex session. Reflect that write
                    // in this source's staged tree, but keep the global tree
                    // untouched until Enter so cancelling still works.
                    let inheritedTreeChanged = false;
                    for (const [key, cell] of combined) {
                        const staged = this.stagedFlexSteps.get(key);
                        if (!staged) continue;
                        if (
                            cell.type !== staged.type ||
                            cell.rotation !== staged.rotation ||
                            cell.flipped !== staged.flipped
                        ) {
                            combined.set(key, { ...staged });
                            inheritedTreeChanged = true;
                        }
                    }
                    if (inheritedTreeChanged) {
                        let stagedTree = this.stagedFlexTrees.get(sourceKey);
                        if (!stagedTree) {
                            stagedTree = new Map();
                            this.stagedFlexTrees.set(sourceKey, stagedTree);
                        }
                        for (const [key, cell] of combined) {
                            if (
                                stagedTree.has(key) ||
                                globalTreeKeys.has(key)
                            ) {
                                stagedTree.set(key, { ...cell });
                            }
                        }
                    }

                    const tree = [...combined.values()];
                    const intact = tree.every((cell) => {
                        const arrow = this.getEffectiveFlexArrowState(cell);
                        return (
                            arrow !== null &&
                            arrow.type === cell.type &&
                            arrow.rotation === cell.rotation &&
                            arrow.flipped === cell.flipped
                        );
                    });
                    if (!intact) {
                        flexRoutingState.forgetTree(point);
                        this.stagedFlexTrees.delete(sourceKey);
                        return [];
                    }
                    return tree;
                }

                private getLiveFlexArrowState(
                    point: GridPoint,
                ): FlexArrowState | null {
                    const controls = this as unknown as PrivatePlayerControls;
                    const arrow = controls.game.gameMap.getArrow(
                        point.x,
                        point.y,
                    );
                    if (!arrow || arrow.type === ArrowType.EMPTY) return null;
                    return {
                        type: arrow.type,
                        rotation: arrow.rotation,
                        flipped: arrow.flipped,
                    };
                }

                private getEffectiveFlexArrowState(
                    point: GridPoint,
                ): FlexArrowState | null {
                    const staged = this.stagedFlexSteps.get(
                        flexPointKey(point),
                    );
                    if (staged) {
                        return {
                            type: staged.type,
                            rotation: staged.rotation,
                            flipped: staged.flipped,
                        };
                    }
                    return this.getLiveFlexArrowState(point);
                }

                private createFlexPlanDeps(): FlexPlanDeps {
                    return {
                        getTree: (point) => this.validatedFlexTree(point),
                        getReservedMarkers: () =>
                            [...this.stagedFlexGhosts.values()].map(
                                (ghost) => ({ ...ghost.marker }),
                            ),
                        getRelativeCell: (
                            point,
                            rotation,
                            flipped,
                            forward,
                            sideways,
                        ) =>
                            getRelativePosition(
                                point.x,
                                point.y,
                                rotation,
                                flipped,
                                forward,
                                sideways,
                            ),
                        getArrowState: (point) =>
                            this.getEffectiveFlexArrowState(point),
                        isStagedCell: (point) =>
                            this.stagedFlexSteps.has(flexPointKey(point)),
                        getOutputCell: (point, state) => {
                            const config = ROUTABLE_ARROWS[state.type];
                            if (!config) return null;
                            return getRelativePosition(
                                point.x,
                                point.y,
                                state.rotation,
                                state.flipped,
                                config.forward,
                                config.sideways,
                            );
                        },
                    };
                }

                private handleFlexKeyDown(event: KeyboardEvent): void {
                    this.syncFlexRoutingMode();
                    const controls = this as unknown as PrivatePlayerControls;
                    const target = event.target;
                    const isEditable =
                        target instanceof HTMLElement &&
                        (target.isContentEditable ||
                            target.tagName === 'INPUT' ||
                            target.tagName === 'TEXTAREA' ||
                            target.tagName === 'SELECT');
                    // Keep normal typing intact, but do not require the canvas to
                    // hold focus: the game commonly leaves focus on a wrapper.
                    if (isEditable) return;

                    const hasModifier =
                        event.ctrlKey || event.metaKey || event.altKey;

                    if (event.code === 'KeyB') {
                        if (event.repeat || hasModifier) return;
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        if (isFlexRoutingModeActive())
                            this.exitFlexRoutingMode();
                        else this.enterFlexRoutingMode();
                        return;
                    }

                    if (!isFlexRoutingModeActive()) return;

                    // Space is reserved by flex mode so the game's normal pause
                    // action cannot consume it. It confirms the released route
                    // into the preview, clears marks, and never commits to map.
                    if (event.code === 'Space') {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        if (
                            event.repeat ||
                            (!this.flexDrag && !this.flexDropPending)
                        )
                            return;

                        // If pressed mid-drag, freeze the current destination and
                        // wait for mouseup. If already released, confirm that
                        // frozen preview directly.
                        if (!this.flexDropPending && this.flexDrag) {
                            const [cursorX, cursorY] =
                                controls.getPositionByMousePosition();
                            this.flexDropPending = true;
                            this.flexDropGrab = { ...this.flexDrag.grab };
                            this.flexDropCursor = { x: cursorX, y: cursorY };
                            this.flexDrag = null;
                        }

                        this.flexConfirmRequested = true;
                        const cursor = this.flexDropCursor;
                        if (cursor) this.refreshFlexPreview(cursor);
                        this.tryConfirmFlexDrop();
                        return;
                    }

                    if (hasModifier) return;

                    if (event.code === 'Enter') {
                        if (
                            event.repeat ||
                            this.flexDrag ||
                            this.flexDropPending ||
                            (this.stagedFlexSteps.size === 0 &&
                                this.stagedFlexGhosts.size === 0)
                        )
                            return;
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        this.commitStagedFlexRouting();
                        return;
                    }

                    if (event.code === 'Escape') {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        if (this.flexDrag || this.flexDropPending)
                            this.clearFlexDrag();
                        else this.exitFlexRoutingMode();
                        return;
                    }

                    if (event.code === 'KeyT') {
                        if (event.repeat) return;
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        flexRoutingState.selectAllMarks();
                        controls.game.screenUpdated = true;
                        return;
                    }

                    // These keys transform the selected marked-cell pattern for
                    // future/current drag plans. They are swallowed in flex mode
                    // so the native game cannot rotate the arrow under cursor.
                    const rotation: FlexRotation | undefined =
                        FLEX_ROTATION_KEYS[event.code];
                    const isFlip = event.code === 'KeyF';
                    if (rotation === undefined && !isFlip) return;
                    if (!flexRoutingState.hasSelection()) return;

                    event.preventDefault();
                    event.stopImmediatePropagation();
                    if (rotation !== undefined) {
                        flexRoutingState.setRotation(rotation);
                    } else if (!event.repeat) {
                        flexRoutingState.toggleFlipped();
                    }

                    // If a drag has been released but not confirmed, recompute
                    // from its frozen cursor so these keys visibly affect the
                    // route that Space will save.
                    if (this.flexDropPending && this.flexDropCursor) {
                        this.flexSearchSignature = null;
                        this.refreshFlexPreview(this.flexDropCursor);
                    }
                    controls.game.screenUpdated = true;
                }

                /**
                 * Reconcile stale state with the B-mode trigger before input is
                 * processed. In normal mode, native keydown handling must receive
                 * W/A/S/D/F unchanged so regular arrow rotation and flipping work.
                 */
                private syncFlexRoutingMode(): void {
                    if (
                        FlexRoutingTrigger.value &&
                        !flexRoutingState.isEnabled()
                    ) {
                        this.enterFlexRoutingMode();
                    } else if (
                        !FlexRoutingTrigger.value &&
                        flexRoutingState.isEnabled()
                    ) {
                        this.exitFlexRoutingMode();
                    }
                }

                private enterFlexRoutingMode(): void {
                    const controls = this as unknown as PrivatePlayerControls;
                    this.pathData = null;
                    controls.game.pathData = null;
                    flexRoutingState.enable();
                    FlexRoutingTrigger.value = true;
                    controls.mouseHandler.setUiInteraction(false);
                    PathBuildingTrigger.value = false;
                    controls.game.screenUpdated = true;
                }

                private exitFlexRoutingMode(): void {
                    const controls = this as unknown as PrivatePlayerControls;
                    this.clearFlexDrag();
                    this.clearStagedFlexRouting();
                    flexRoutingState.clearMode();
                    FlexRoutingTrigger.value = false;
                    controls.mouseHandler.setUiInteraction(false);
                    controls.game.screenUpdated = true;
                }

                public override dispose(): void {
                    if (activeFlexKeyHandler === this.onFlexKeyDown) {
                        activeFlexKeyHandler = null;
                    }
                    window.removeEventListener(
                        'click',
                        this.onFlexBoardClick,
                        true,
                    );
                    const controls = this as unknown as PrivatePlayerControls;
                    this.clearFlexDrag();
                    this.clearStagedFlexRouting();
                    flexRoutingState.clearMode();
                    FlexRoutingTrigger.value = false;
                    controls.mouseHandler.leftClickCallback =
                        this.oldLeftClickCallback;
                    super.dispose();
                }

                private commitPath(path: PathStep[]): void {
                    this.pathData = null;
                    const controls = this as unknown as PrivatePlayerControls;
                    controls.game.pathData = null;
                    PathBuildingTrigger.value = false;
                    if (path.length === 0) return;
                    this.writeSteps(path);
                }

                /** Writes steps as one undoable history entry. */
                private writeSteps(steps: readonly PathStep[]): void {
                    const controls = this as unknown as PrivatePlayerControls;
                    const gameMap = controls.game.gameMap;
                    const newState = new _PlayerMapAction.val();

                    for (const step of steps) {
                        const [chunk, arrow] = gameMap.getOrCreateArrow(
                            step.x,
                            step.y,
                        );
                        const oldData = _ArrowData.val.fromArrow(arrow);
                        const newData = _ArrowData.val.fromState(
                            step.type,
                            step.rotation,
                            step.flipped,
                        );
                        newState.addChangedArrow(
                            step.x,
                            step.y,
                            oldData,
                            newData,
                        );

                        arrow.type = step.type;
                        arrow.rotation = step.rotation;
                        arrow.flipped = step.flipped;
                        gameMap.updateArrowState(arrow, chunk, step.x, step.y);
                    }

                    const history = controls.history as any;
                    if (history) {
                        history.pushState(newState);
                        history.lastChangeTime = Number.NEGATIVE_INFINITY;
                    }
                    controls.game.screenUpdated = true;
                }
            };
        },
    );
};
