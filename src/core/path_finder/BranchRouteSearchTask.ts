import type { GameMap } from '@logic-arrows/game-logic/game-map';
import type { ITask } from '../task/ITask';
import { getPathCellKey, reservePath } from './BatchPathReservations';
import { PathFindingTask } from './PathFindingTask';
import { getRouteOrderCandidates } from './RouteOrders';
import type { PathStep } from './types';

export interface BranchPoint {
    x: number;
    y: number;
}

/**
 * One way a request can be connected. `start` is where the new cable begins.
 * `upgrades` are writes to existing cells that must accompany the route, such
 * as turning a cable arrow into a splitter so it also feeds `start`.
 */
export interface BranchCandidate {
    start: BranchPoint;
    upgrades: PathStep[];
}

export interface BranchRequest {
    id: string;
    end: BranchPoint;
    candidates: BranchCandidate[];
}

export interface BranchResult {
    id: string;
    steps: PathStep[];
    upgrades: PathStep[];
}

interface Chosen {
    candidate: BranchCandidate;
    steps: PathStep[];
}

/**
 * Connects each request to one of its candidate starts. Candidates are tried
 * in turn and the shortest route wins, so an existing cable can serve as a
 * branch point. Requests share one reservation set, and no two requests may
 * touch a common cell, so cables of different inputs never merge. The whole
 * set is retried under a few request orders before it is reported as failed.
 */
export class BranchRouteSearchTask implements ITask<BranchResult[] | null> {
    public isCanceled = false;
    public stepBatchSize = 40;

    private readonly gameMap: GameMap;
    private readonly requests: BranchRequest[];
    private readonly blockedCells: ReadonlySet<string>;
    private readonly orders: number[][];
    private orderIndex = 0;
    private position = 0;
    private candidateIndex = 0;
    private best: Chosen | null = null;
    private search: PathFindingTask | null = null;
    private reservations = new Map<string, PathStep>();
    /** Existing cable cells already rewritten by an accepted request. */
    private upgraded = new Set<string>();
    private results: BranchResult[] = [];
    private isDone = false;
    private resultList: BranchResult[] | null = null;

    public constructor(
        gameMap: GameMap,
        requests: readonly BranchRequest[],
        blockedCells: ReadonlySet<string> = new Set(),
    ) {
        this.gameMap = gameMap;
        this.blockedCells = blockedCells;
        this.requests = requests.map((request) => ({
            ...request,
            candidates: [...request.candidates],
        }));
        this.orders = getRouteOrderCandidates(
            this.requests.map((request) => {
                const first = request.candidates[0]?.start ?? request.end;
                return {
                    startX: first.x,
                    startY: first.y,
                    endX: request.end.x,
                    endY: request.end.y,
                };
            }),
        );
        if (this.requests.length === 0) this.complete([]);
    }

    public step(maxStepsCount: number): boolean {
        if (this.isDone || this.isCanceled) return true;

        while (true) {
            const order = this.orders[this.orderIndex];
            if (order === undefined) {
                this.complete(null);
                return true;
            }
            if (this.position >= order.length) {
                this.complete(this.results);
                return true;
            }

            const request = this.requests[order[this.position]];
            if (this.candidateIndex >= request.candidates.length) {
                if (this.best === null || !this.accept(request.id, this.best)) {
                    this.failOrder();
                }
                continue;
            }

            const candidate = request.candidates[this.candidateIndex];
            if (
                this.reservations.has(
                    getPathCellKey(candidate.start.x, candidate.start.y),
                )
            ) {
                this.candidateIndex += 1;
                continue;
            }

            if (
                candidate.start.x === request.end.x &&
                candidate.start.y === request.end.y
            ) {
                this.consider(candidate, []);
                this.candidateIndex += 1;
                continue;
            }

            this.search ??= new PathFindingTask(
                this.gameMap,
                candidate.start.x,
                candidate.start.y,
                request.end.x,
                request.end.y,
                this.reservations,
                this.blockedCells,
            );
            if (!this.search.step(maxStepsCount)) return false;

            const path = this.search.getResult();
            this.search = null;
            if (path) this.consider(candidate, path);
            this.candidateIndex += 1;
            return false;
        }
    }

    public getResult(): BranchResult[] | null {
        return this.resultList;
    }

    private consider(candidate: BranchCandidate, steps: PathStep[]): void {
        // Two requests may not rewrite the same existing cell, since their
        // splitter settings would contradict each other.
        const touchesUpgrade = candidate.upgrades.some((upgrade) => {
            const key = getPathCellKey(upgrade.x, upgrade.y);
            return this.upgraded.has(key) || this.reservations.has(key);
        });
        if (touchesUpgrade) return;

        // A route may not share any cell with another request in this batch,
        // even an identical arrow, so signals of different inputs never merge.
        if (
            steps.some((step) =>
                this.reservations.has(getPathCellKey(step.x, step.y)),
            )
        ) {
            return;
        }
        if (this.best === null || steps.length < this.best.steps.length) {
            this.best = { candidate, steps };
        }
    }

    private accept(id: string, chosen: Chosen): boolean {
        if (!reservePath(chosen.steps, this.reservations)) return false;
        for (const upgrade of chosen.candidate.upgrades) {
            this.upgraded.add(getPathCellKey(upgrade.x, upgrade.y));
        }
        this.results.push({
            id,
            steps: chosen.steps,
            upgrades: chosen.candidate.upgrades,
        });
        this.position += 1;
        this.candidateIndex = 0;
        this.best = null;
        return true;
    }

    private failOrder(): void {
        this.orderIndex += 1;
        this.position = 0;
        this.candidateIndex = 0;
        this.best = null;
        this.search = null;
        this.reservations = new Map();
        this.upgraded = new Set();
        this.results = [];
    }

    private complete(result: BranchResult[] | null): void {
        this.resultList = result;
        this.isDone = true;
    }
}
