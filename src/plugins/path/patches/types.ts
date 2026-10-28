import type { PathStep } from 'src/core/path_finder/types';
import type { ArrowType } from 'src/core/utils/ArrowType';

export interface GridPoint {
    x: number;
    y: number;
}

export interface PathData {
    startPathX: number;
    startPathY: number;
    endPathX: number;
    endPathY: number;
    lastGraphUpdate: number;
    path: PathStep[];
    arrowType: ArrowType;
    rotation: number;
    flip: boolean;
}

export interface FlexArrowState {
    type: ArrowType;
    rotation: number;
    flipped: boolean;
}

/** Preview of a marker's target and the separate arrow that feeds it. */
export interface FlexGhost {
    /** Original input/marker that owns this intended destination. */
    source?: GridPoint;
    /** The marker's destination cell. This cell must never receive a new arrow. */
    marker: GridPoint;
    /** The feeder arrow's cell, always separate from `marker` when routable. */
    point: GridPoint;
    arrowState: FlexArrowState | null;
    blocked: boolean;
}

export type FlexPreviewStatus = 'idle' | 'pending' | 'ok' | 'failed';

export interface FlexPreviewState {
    status: FlexPreviewStatus;
    ghosts: FlexGhost[];
    steps: PathStep[];
}
