import type { GameMap } from '@logic-arrows/game-logic/game-map';
import type { ITask } from '../task/ITask';
import { ArrowType } from '../utils/ArrowType';
import { getRelativePosition } from '../utils/getRelativePosition';
import { getPathCellKey } from './BatchPathReservations';
import { type BiSearchNode, SearchGridManager } from './BiSearchNode';
import { MinHeap } from './MinHeap';
import {
    type AllowedArrow,
    ARROW_CONFIGS,
    ARROW_TYPES_LIST,
    Direction,
    HEURISTIC_TIEBREAKER,
    NodeStatus,
    type PathStep,
} from './types';

export class PathFindingTask implements ITask<PathStep[] | null> {
    public isCanceled = false;
    public stepBatchSize = 40;

    private readonly gameMap: GameMap;
    private readonly startX: number;
    private readonly startY: number;
    private readonly endX: number;
    private readonly endY: number;
    private readonly reservedPath: ReadonlyMap<string, PathStep>;
    private readonly blockedCells: ReadonlySet<string>;
    /** Optional route-style variation used by the flex global solver. */
    private readonly pathVariant: number;

    private readonly grid = new SearchGridManager();
    private readonly heapForward = new MinHeap();
    private readonly heapBackward = new MinHeap();
    private readonly startPacked: number;
    private readonly endPacked: number;

    private bestPathCost = Infinity;
    private bestIntersectionPacked = -1;
    private isDone = false;
    private resultPath: PathStep[] | null = null;

    public constructor(
        gameMap: GameMap,
        startX: number,
        startY: number,
        endX: number,
        endY: number,
        reservedPath: ReadonlyMap<string, PathStep> = new Map(),
        blockedCells: ReadonlySet<string> = new Set(),
        pathVariant = 0,
    ) {
        this.gameMap = gameMap;
        this.startX = startX;
        this.startY = startY;
        this.endX = endX;
        this.endY = endY;
        this.reservedPath = reservedPath;
        this.blockedCells = blockedCells;
        this.pathVariant = pathVariant;

        this.startPacked = this.grid.pack(startX, startY);
        this.endPacked = this.grid.pack(endX, endY);

        const startNode = this.grid.getNode(this.startPacked);
        startNode.gScore[Direction.FORWARD] = 0;
        startNode.status[Direction.FORWARD] = NodeStatus.OPEN;

        const endNode = this.grid.getNode(this.endPacked);
        endNode.gScore[Direction.BACKWARD] = 0;
        endNode.status[Direction.BACKWARD] = NodeStatus.OPEN;

        const getHeuristic = (
            x1: number,
            y1: number,
            x2: number,
            y2: number,
        ): number =>
            (Math.abs(x1 - x2) + Math.abs(y1 - y2)) * HEURISTIC_TIEBREAKER;

        this.heapForward.push(
            this.startPacked,
            getHeuristic(startX, startY, endX, endY),
        );
        this.heapBackward.push(
            this.endPacked,
            getHeuristic(endX, endY, startX, startY),
        );
    }

    public step(maxStepsCount: number): boolean {
        if (this.isDone || this.isCanceled) {
            return true;
        }

        let stepsRun = 0;

        while (
            this.heapForward.size > 0 &&
            this.heapBackward.size > 0 &&
            stepsRun < maxStepsCount
        ) {
            stepsRun += 1;

            if (
                this.heapForward.minScore >= this.bestPathCost &&
                this.heapBackward.minScore >= this.bestPathCost
            ) {
                this.complete(
                    this.reconstructPath(this.bestIntersectionPacked),
                );
                return true;
            }

            this.expandFront(
                this.gameMap,
                this.heapForward,
                Direction.FORWARD,
                this.endX,
                this.endY,
                (cost, packed) => {
                    if (cost < this.bestPathCost) {
                        this.bestPathCost = cost;
                        this.bestIntersectionPacked = packed;
                    }
                },
            );

            this.expandFront(
                this.gameMap,
                this.heapBackward,
                Direction.BACKWARD,
                this.startX,
                this.startY,
                (cost, packed) => {
                    if (cost < this.bestPathCost) {
                        this.bestPathCost = cost;
                        this.bestIntersectionPacked = packed;
                    }
                },
            );
        }

        if (this.heapForward.size === 0 || this.heapBackward.size === 0) {
            if (this.bestIntersectionPacked !== -1) {
                this.complete(
                    this.reconstructPath(this.bestIntersectionPacked),
                );
            } else {
                this.complete(null);
            }
            return true;
        }

        return false;
    }

    public getResult(): PathStep[] | null {
        return this.resultPath;
    }

    private expandFront(
        gameMap: GameMap,
        heap: MinHeap,
        dir: Direction,
        targetX: number,
        targetY: number,
        onIntersection: (cost: number, packed: number) => void,
    ): void {
        const currentPacked = heap.pop();
        if (currentPacked === undefined) {
            return;
        }
        const currNode = this.grid.getNode(currentPacked);

        if (currNode.status[dir] === NodeStatus.CLOSED) {
            return;
        }
        currNode.status[dir] = NodeStatus.CLOSED;

        const { x: currentX, y: currentY } = this.grid.unpack(currentPacked);

        for (const arrowType of ARROW_TYPES_LIST) {
            const config = ARROW_CONFIGS[arrowType];

            for (let rotation = 0; rotation < 4; rotation += 1) {
                for (const flipped of [false, true]) {
                    if (arrowType !== ArrowType.DIAGONAL_ARROW && flipped) {
                        continue;
                    }

                    const modifier = dir === Direction.FORWARD ? 1 : -1;
                    const { x: nextX, y: nextY } = getRelativePosition(
                        currentX,
                        currentY,
                        rotation,
                        flipped,
                        config.forward * modifier,
                        config.sideways * modifier,
                    );

                    const arrow = gameMap.getArrow(nextX, nextY);
                    const isDestination =
                        nextX === this.endX && nextY === this.endY;
                    if (this.blockedCells.has(getPathCellKey(nextX, nextY))) {
                        continue;
                    }
                    if (
                        !isDestination &&
                        arrow &&
                        arrow.astIndex !== undefined &&
                        arrow.astIndex !== null
                    ) {
                        const node = gameMap.graph.getNode(arrow.astIndex);
                        if (node.backLinks.length !== 0) {
                            continue;
                        }
                    }

                    if (!isDestination && arrow && arrow.type !== 0) {
                        continue;
                    }

                    const arrowX = dir === Direction.FORWARD ? currentX : nextX;
                    const arrowY = dir === Direction.FORWARD ? currentY : nextY;
                    const reservedArrow = this.reservedPath.get(
                        getPathCellKey(arrowX, arrowY),
                    );
                    if (
                        reservedArrow &&
                        (reservedArrow.type !== arrowType ||
                            reservedArrow.rotation !== rotation ||
                            reservedArrow.flipped !== flipped)
                    ) {
                        continue;
                    }

                    const targetPacked = this.grid.pack(nextX, nextY);
                    const targetNode = this.grid.getNode(targetPacked);

                    if (targetNode.status[dir] === NodeStatus.CLOSED) {
                        continue;
                    }

                    const oppDir =
                        dir === Direction.FORWARD
                            ? Direction.BACKWARD
                            : Direction.FORWARD;

                    let stepWeight = this.getPathWeight(
                        arrowType,
                        config.weight,
                    );
                    const parentPacked = currNode.parent[dir];

                    if (parentPacked !== -1) {
                        const backLinkedNode = this.grid.getNode(parentPacked);
                        if (backLinkedNode.arrowRotation[dir] !== rotation) {
                            stepWeight += 0.05;
                        }
                    }

                    const tentativeG = currNode.gScore[dir] + stepWeight;

                    if (tentativeG < targetNode.gScore[dir]) {
                        this.recordStep(
                            targetNode,
                            currentPacked,
                            arrowType,
                            rotation,
                            flipped,
                            dir,
                        );
                        targetNode.gScore[dir] = tentativeG;
                        targetNode.status[dir] = NodeStatus.OPEN;

                        const fScore =
                            tentativeG +
                            (Math.abs(nextX - targetX) +
                                Math.abs(nextY - targetY)) *
                                HEURISTIC_TIEBREAKER;
                        heap.push(targetPacked, fScore);

                        if (
                            targetNode.status[oppDir] !== NodeStatus.UNVISITED
                        ) {
                            const cost = tentativeG + targetNode.gScore[oppDir];
                            onIntersection(cost, targetPacked);
                        }
                    }
                }
            }
        }
    }

    /**
     * Produces distinct but still bounded path shapes for global flex retries.
     * Every weight stays positive; ordinary pathfinding keeps the original
     * arrow weights because its default variant is zero.
     */
    private getPathWeight(arrowType: AllowedArrow, baseWeight: number): number {
        switch (((this.pathVariant % 8) + 8) % 8) {
            case 1:
                // Explore layouts that use blue arrows to jump over crowded cells.
                if (arrowType === ArrowType.BLUE_ARROW) return 1.0;
                if (arrowType === ArrowType.DIAGONAL_ARROW) return 1.25;
                return 1.45;
            case 2:
                // Explore diagonal corridors when the red/blue grid lines clash.
                if (arrowType === ArrowType.DIAGONAL_ARROW) return 1.0;
                if (arrowType === ArrowType.ARROW) return 1.3;
                return 1.55;
            case 3:
                // A red-first pass is useful when long blue outputs would
                // activate an unwanted downstream arrow.
                if (arrowType === ArrowType.ARROW) return 1.0;
                if (arrowType === ArrowType.DIAGONAL_ARROW) return 1.25;
                return 1.45;
            case 4:
                // Prefer simple red/diagonal runs over long blue jumps. This
                // often avoids accidentally feeding an arrow in front of a
                // blue splitter or blue arrow.
                if (arrowType === ArrowType.ARROW) return 1.0;
                if (arrowType === ArrowType.DIAGONAL_ARROW) return 1.6;
                return 2.3;
            case 5:
                // Keep diagonal arrows out of dense vertical/horizontal lanes.
                if (arrowType === ArrowType.ARROW) return 1.0;
                if (arrowType === ArrowType.BLUE_ARROW) return 1.8;
                return 2.2;
            case 6:
                // Prefer a balanced mixture so a new branch can reuse lanes
                // without repeating the exact same route shape.
                if (arrowType === ArrowType.BLUE_ARROW) return 1.1;
                if (arrowType === ArrowType.DIAGONAL_ARROW) return 1.15;
                return 1.2;
            case 7:
                // The opposite mixed preference explores blue-heavy trunks
                // with red side corridors as a separate topology family.
                if (arrowType === ArrowType.BLUE_ARROW) return 1.05;
                if (arrowType === ArrowType.ARROW) return 1.35;
                return 1.2;
            default:
                return baseWeight;
        }
    }

    private recordStep(
        node: BiSearchNode,
        parentPacked: number,
        type: ArrowType,
        rotation: number,
        flipped: boolean,
        dir: Direction,
    ): void {
        node.parent[dir] = parentPacked;
        node.arrowType[dir] = type;
        node.arrowRotation[dir] = rotation;
        node.arrowFlipped[dir] = flipped;
    }

    private reconstructPath(intersectionPacked: number): PathStep[] {
        const path: PathStep[] = [];
        const forwardChain: number[] = [];

        let current = intersectionPacked;
        while (current !== -1) {
            forwardChain.push(current);
            current = this.grid.getNode(current).parent[Direction.FORWARD];
        }
        forwardChain.reverse();

        for (let i = 0; i < forwardChain.length - 1; i += 1) {
            const packedPos = forwardChain[i];
            const targetNode = this.grid.getNode(forwardChain[i + 1]);
            const pos = this.grid.unpack(packedPos);

            path.push({
                x: pos.x,
                y: pos.y,
                type: targetNode.arrowType[Direction.FORWARD],
                rotation: targetNode.arrowRotation[Direction.FORWARD],
                flipped: targetNode.arrowFlipped[Direction.FORWARD],
            });
        }

        current = intersectionPacked;
        while (current !== -1) {
            const node = this.grid.getNode(current);
            if (node.parent[Direction.BACKWARD] !== -1) {
                const pos = this.grid.unpack(current);
                path.push({
                    x: pos.x,
                    y: pos.y,
                    type: node.arrowType[Direction.BACKWARD],
                    rotation: node.arrowRotation[Direction.BACKWARD],
                    flipped: node.arrowFlipped[Direction.BACKWARD],
                });
            }
            current = node.parent[Direction.BACKWARD];
        }

        return path;
    }

    private complete(result: PathStep[] | null): void {
        this.resultPath = result;
        this.isDone = true;

        this.grid.clear();
        this.heapForward.clear();
        this.heapBackward.clear();
    }
}
