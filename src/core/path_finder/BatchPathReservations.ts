import type { PathStep } from './types';

export function getPathCellKey(x: number, y: number): string {
    return `${x},${y}`;
}

export function canReservePath(
    path: PathStep[],
    reservations: ReadonlyMap<string, PathStep>,
): boolean {
    return path.every((step) => {
        const reserved = reservations.get(getPathCellKey(step.x, step.y));
        return (
            reserved === undefined ||
            (reserved.type === step.type &&
                reserved.rotation === step.rotation &&
                reserved.flipped === step.flipped)
        );
    });
}

export function reservePath(
    path: PathStep[],
    reservations: Map<string, PathStep>,
): boolean {
    if (!canReservePath(path, reservations)) return false;

    for (const step of path) {
        const key = getPathCellKey(step.x, step.y);
        if (!reservations.has(key)) reservations.set(key, step);
    }
    return true;
}
