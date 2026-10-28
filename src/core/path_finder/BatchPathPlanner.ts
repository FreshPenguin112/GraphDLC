import type { GameMap } from '@logic-arrows/game-logic/game-map';
import type { ITask } from '../task/ITask';
import { canReservePath, getPathCellKey } from './BatchPathReservations';
import { PathFindingTask } from './PathFindingTask';
import type { PathStep } from './types';

export interface BatchConnectionGroup {
    input: GridPoint;
    outputs: GridPoint[];
}

export interface GridPoint {
    x: number;
    y: number;
}

export interface RoutePlanStatus {
    success: boolean;
    error?: string;
    timedOut: boolean;
}

export interface BatchRoutePlan {
    groups: BatchConnectionGroup[];
    routes: PathStep[][];
    status: RoutePlanStatus;
}

export interface BatchPreviewData {
    groups: BatchConnectionGroup[];
    routes: PathStep[][];
    sharedCells: Map<string, PathStep[]>;
}

export class BatchPathPlanner implements ITask<BatchRoutePlan> {
    public isCanceled = false;
    public stepBatchSize = 40;

    private readonly gameMap: GameMap;
    private readonly groups: BatchConnectionGroup[];
    private readonly routeRequests: Array<{
        groupIndex: number;
        input: { x: number; y: number };
        output: { x: number; y: number };
    }>;
    private reservations: Map<string, PathStep> = new Map();
    private allRouteSteps: PathStep[][][] = [];
    private routeCount = 0;
    private totalRoutes = 0;
    private currentTask: PathFindingTask | null = null;
    public isDone = false;
    private resultPlan: BatchRoutePlan | null = null;
    private startTime = 0;
    private timeoutMs = 5000;

    public constructor(gameMap: GameMap, groups: BatchConnectionGroup[]) {
        this.gameMap = gameMap;
        this.groups = [...groups];
        this.routeRequests = groups.flatMap((group, groupIndex) =>
            group.outputs.map((output) => ({
                groupIndex,
                input: group.input,
                output,
            })),
        );
        this.routeRequests.sort((left, right) => {
            const leftDistance =
                Math.abs(left.output.x - left.input.x) +
                Math.abs(left.output.y - left.input.y);
            const rightDistance =
                Math.abs(right.output.x - right.input.x) +
                Math.abs(right.output.y - right.input.y);
            return rightDistance - leftDistance;
        });
        this.totalRoutes = this.routeRequests.length;
        this.startTime = Date.now();
    }

    public setTimeout(ms: number): void {
        this.timeoutMs = ms;
    }

    public step(maxStepsCount: number): boolean {
        if (this.isCanceled || this.isDone) return true;

        const elapsed = Date.now() - this.startTime;
        if (elapsed > this.timeoutMs) {
            this.complete({
                groups: this.groups,
                routes: [],
                status: {
                    success: false,
                    timedOut: true,
                    error: 'Planning timed out',
                },
            });
            return true;
        }

        if (this.routeCount >= this.totalRoutes) {
            this.complete({
                groups: this.groups,
                routes: this._extractAllRoutes(),
                status: { success: true, timedOut: false },
            });
            return true;
        }

        const request = this.routeRequests[this.routeCount];

        this.currentTask ??= new PathFindingTask(
            this.gameMap,
            request.input.x,
            request.input.y,
            request.output.x,
            request.output.y,
            this.reservations,
        );

        if (!this.currentTask.step(maxStepsCount)) return false;

        const path = this.currentTask.getResult();
        this.currentTask = null;
        if (!path || path.length === 0) {
            this.isDone = true;
            this.complete({
                groups: this.groups,
                routes: [],
                status: {
                    success: false,
                    timedOut: false,
                    error: 'Route planning failed',
                },
            });
            return true;
        }

        if (!canReservePath(path, this.reservations)) {
            this.isDone = true;
            this.complete({
                groups: this.groups,
                routes: [],
                status: {
                    success: false,
                    timedOut: false,
                    error: 'Cell reservation conflict',
                },
            });
            return true;
        }

        // Reserve path cells
        for (const step of path) {
            const key = getPathCellKey(step.x, step.y);
            if (!this.reservations.has(key)) {
                this.reservations.set(key, step);
            }
        }

        // Store this route for this group
        if (this.routeCount === 0) {
            this.allRouteSteps = [];
        }
        if (!this.allRouteSteps[request.groupIndex]) {
            this.allRouteSteps[request.groupIndex] = [];
        }
        this.allRouteSteps[request.groupIndex].push(path);

        this.routeCount += 1;
        return false;
    }

    private _extractAllRoutes(): PathStep[][] {
        const routes: PathStep[][] = [];
        for (const groupRoutes of this.allRouteSteps) {
            for (const route of groupRoutes) {
                routes.push(route);
            }
        }
        return routes;
    }

    public getResult(): BatchRoutePlan {
        return this.resultPlan!;
    }

    private complete(result: BatchRoutePlan): void {
        this.resultPlan = result;
        this.isDone = true;
        this.reservations.clear();
    }

    public cancel(): void {
        this.isCanceled = true;
    }
}
