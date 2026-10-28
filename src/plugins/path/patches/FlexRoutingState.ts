import type { FlexTreeCell } from './FlexRoutingPlanner';
import type { GridPoint } from './types';

export type FlexRotation = 0 | 1 | 2 | 3;

export interface FlexTransform {
    rotation: FlexRotation;
    flipped: boolean;
}

function keyOf(point: GridPoint): string {
    return `${point.x},${point.y}`;
}

/**
 * Flex-routing marks and the current selection of marks.
 *
 * Marks live beside the map, never in it: a mark may sit on an empty cell or
 * on top of an arrow without changing that arrow. The selection is a subset
 * of the marks, and the rotation/flip transform belongs to the selection.
 */
export class FlexRoutingState {
    private enabled = false;
    private readonly marks = new Map<string, GridPoint>();
    private readonly selected = new Set<string>();
    private rotation: FlexRotation = 0;
    private flipped = false;
    /**
     * Cable cells each input owns, keyed by input, then by cell. Trees are kept
     * across mode exits because the arrows stay on the map.
     */
    private readonly trees = new Map<string, Map<string, FlexTreeCell>>();

    public enable(): void {
        this.enabled = true;
    }

    public isEnabled(): boolean {
        return this.enabled;
    }

    /** Leaves flex mode and forgets every mark, selection and transform. */
    public clearMode(): void {
        this.enabled = false;
        this.marks.clear();
        this.clearSelection();
    }

    /** Marks an empty cell or unmarks a marked one. Returns the new state. */
    public toggleMark(point: GridPoint): boolean {
        const key = keyOf(point);
        if (this.marks.has(key)) {
            this.marks.delete(key);
            this.selected.delete(key);
            return false;
        }
        this.marks.set(key, { x: point.x, y: point.y });
        return true;
    }

    public hasMark(point: GridPoint): boolean {
        return this.marks.has(keyOf(point));
    }

    /** Removes all marks after a drag has been explicitly saved to preview. */
    public clearMarks(): void {
        this.marks.clear();
        this.clearSelection();
    }

    public getMarks(): GridPoint[] {
        return [...this.marks.values()].map((mark) => ({ ...mark }));
    }

    public isSelected(point: GridPoint): boolean {
        return this.selected.has(keyOf(point));
    }

    public hasSelection(): boolean {
        return this.selected.size > 0;
    }

    /** Selected marks in the order they were placed. */
    public getSelectedMarks(): GridPoint[] {
        return [...this.marks.values()]
            .filter((mark) => this.selected.has(keyOf(mark)))
            .map((mark) => ({ ...mark }));
    }

    /**
     * Selects every mark, or clears the selection when every mark is already
     * selected. Clearing the selection also resets its transform.
     */
    public selectAllMarks(): void {
        const allSelected =
            this.marks.size > 0 &&
            [...this.marks.keys()].every((key) => this.selected.has(key));
        if (allSelected) {
            this.clearSelection();
            return;
        }
        for (const key of this.marks.keys()) this.selected.add(key);
    }

    public clearSelection(): void {
        this.selected.clear();
        this.resetTransform();
    }

    /** Stable text key for the selection, used to detect changes. */
    public getSelectionKey(): string {
        return [...this.selected].sort().join(';');
    }

    public getTransform(): FlexTransform {
        return { rotation: this.rotation, flipped: this.flipped };
    }

    /** Sets the absolute rotation, matching W/D/S/A selection rotation. */
    public setRotation(rotation: FlexRotation): void {
        this.rotation = rotation;
    }

    public toggleFlipped(): void {
        this.flipped = !this.flipped;
    }

    /** Owned cable cells for an input, as last recorded. */
    public getTree(point: GridPoint): FlexTreeCell[] {
        const tree = this.trees.get(keyOf(point));
        if (!tree) return [];
        return [...tree.values()].map((cell) => ({ ...cell }));
    }

    /** All recorded trees, used to stage updates when a shared cell is replaced. */
    public getAllTrees(): Array<{ point: GridPoint; cells: FlexTreeCell[] }> {
        const trees: Array<{ point: GridPoint; cells: FlexTreeCell[] }> = [];
        for (const [sourceKey, tree] of this.trees) {
            const [xText, yText] = sourceKey.split(',');
            const x = Number(xText);
            const y = Number(yText);
            if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
            trees.push({
                point: { x, y },
                cells: [...tree.values()].map((cell) => ({ ...cell })),
            });
        }
        return trees;
    }

    /** Records cells written for an input so later drops can branch from them. */
    public recordWrites(
        point: GridPoint,
        writes: readonly FlexTreeCell[],
    ): void {
        const key = keyOf(point);
        let tree = this.trees.get(key);
        if (!tree) {
            tree = new Map();
            this.trees.set(key, tree);
        }
        for (const write of writes) {
            tree.set(`${write.x},${write.y}`, { ...write });
        }
    }

    /** Replaces a source's recorded tree after staged routes have rerouted it. */
    public replaceTree(
        point: GridPoint,
        writes: readonly FlexTreeCell[],
    ): void {
        const key = keyOf(point);
        this.trees.set(
            key,
            new Map(writes.map((write) => [keyOf(write), { ...write }])),
        );
    }

    public forgetTree(point: GridPoint): void {
        this.trees.delete(keyOf(point));
    }

    public resetTransform(): void {
        this.rotation = 0;
        this.flipped = false;
    }
}

export const flexRoutingState = new FlexRoutingState();
