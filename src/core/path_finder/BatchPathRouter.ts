import type { GameMap } from '@logic-arrows/game-logic/game-map';
import type { ITask } from '../task/ITask';
import { reservePath } from './BatchPathReservations';
import { PathFindingTask } from './PathFindingTask';
import type { PathStep } from './types';

export interface BatchPathRoute {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
}

export class BatchPathRouter implements ITask<PathStep[] | null> {
    public isCanceled = false;
    public stepBatchSize = 40;

    private readonly routes: BatchPathRoute[];
    private readonly gameMap: GameMap;
    private readonly reservations = new Map<string, PathStep>();
    private routeIndex = 0;
    private currentTask: PathFindingTask | null = null;
    private isDone = false;
    private resultPath: PathStep[] | null = null;

    public constructor(
        gameMap: GameMap,
        routes: readonly BatchPathRoute[],
        preserveOrder = false,
    ) {
        this.gameMap = gameMap;
        if (preserveOrder) {
            this.routes = [...routes];
            return;
        }
        this.routes = [...routes].sort((left, right) => {
            const leftDistance =
                Math.abs(left.endX - left.startX) +
                Math.abs(left.endY - left.startY);
            const rightDistance =
                Math.abs(right.endX - right.startX) +
                Math.abs(right.endY - right.startY);
            return rightDistance - leftDistance;
        });
    }

    public step(maxStepsCount: number): boolean {
        if (this.isCanceled || this.isDone) return true;
        if (this.routeIndex >= this.routes.length) {
            this.complete([...this.reservations.values()]);
            return true;
        }

        const route = this.routes[this.routeIndex];
        this.currentTask ??= new PathFindingTask(
            this.gameMap,
            route.startX,
            route.startY,
            route.endX,
            route.endY,
            this.reservations,
        );

        if (!this.currentTask.step(maxStepsCount)) return false;

        const path = this.currentTask.getResult();
        if (!path || !reservePath(path, this.reservations)) {
            this.complete(null);
            return true;
        }

        this.currentTask = null;
        this.routeIndex += 1;
        if (this.routeIndex < this.routes.length) return false;

        this.complete([...this.reservations.values()]);
        return true;
    }

    public getResult(): PathStep[] | null {
        return this.resultPath;
    }

    private complete(result: PathStep[] | null): void {
        this.resultPath = result;
        this.isDone = true;
    }
}
