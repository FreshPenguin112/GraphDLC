import type { GameMap } from '@logic-arrows/game-logic/game-map';
import { AsyncScheduler } from 'src/core/task/AsyncScheduler';
import type { ArrowType } from '../utils/ArrowType';
import {
    type BranchRequest,
    type BranchResult,
    BranchRouteSearchTask,
} from './BranchRouteSearchTask';
import { LinearPathFindingTask } from './LinearPathFindingTask';
import { PathFindingTask } from './PathFindingTask';
import type { PathStep } from './types';

export class PathFinder {
    private readonly scheduler = new AsyncScheduler(() => 33);

    public findPathAsync(
        key: any,
        gameMap: GameMap,
        startX: number,
        startY: number,
        endX: number,
        endY: number,
        onComplete: (path: PathStep[] | null) => void,
    ): void {
        const task = new PathFindingTask(gameMap, startX, startY, endX, endY);
        this.scheduler.schedule(task, onComplete, key);
    }

    public findLinearPathAsync(
        key: any,
        startX: number,
        startY: number,
        endX: number,
        endY: number,
        arrowType: ArrowType,
        rotation: number,
        flipped: boolean,
        onComplete: (path: PathStep[] | null) => void,
    ): void {
        const task = new LinearPathFindingTask(startX, startY, endX, endY);
        this.scheduler.schedule(
            task,
            (linearPath) => {
                onComplete(
                    linearPath.map((step) => ({
                        x: step.x,
                        y: step.y,
                        type: arrowType,
                        rotation,
                        flipped,
                    })),
                );
            },
            key,
        );
    }

    /**
     * Connects every request through one of its candidate starts, sharing
     * reservations. Resolves to null when no complete set is found.
     */
    public findBranchRoutesAsync(
        key: any,
        gameMap: GameMap,
        requests: readonly BranchRequest[],
        onComplete: (results: BranchResult[] | null) => void,
        blockedCells: ReadonlySet<string> = new Set(),
    ): void {
        const task = new BranchRouteSearchTask(gameMap, requests, blockedCells);
        this.scheduler.schedule(task, onComplete, key);
    }

    /** Schedule a domain-specific routing task on the same cancellable async scheduler. */
    public scheduleTask<R>(
        key: any,
        task: import('../task/ITask').ITask<R>,
        onComplete: (result: R) => void,
    ): void {
        this.scheduler.schedule(task, onComplete, key);
    }

    public forceCompletePath(key: any): PathStep[] | null {
        return this.scheduler.forceComplete<PathStep[] | null>(key) ?? null;
    }

    public cancelPathSearch(key: any): void {
        this.scheduler.cancel(key);
    }
}
