import type { Game } from '@logic-arrows/game-logic/game';
import type { GameMap } from '@logic-arrows/game-logic/game-map';
import type { GameRender } from '@logic-arrows/rendering/game-render';
import type { GraphDLC } from 'src/core/GraphDLC';
import type { PatchLoader } from 'src/core/PatchLoader';
import type { IPatcher } from '../../Patcher';
import { flexRoutingState } from './FlexRoutingState';
import type { FlexPreviewState, PathData } from './types';

interface PrivateGame {
    gameMap: GameMap;
    readonly render: GameRender;

    updateTime: number;
    tps: number;
    tick: number;
    updatesPerSecond: number;
}

const IDLE_PREVIEW: FlexPreviewState = {
    status: 'idle',
    ghosts: [],
    steps: [],
};

export const PatchGame: IPatcher = (
    patchLoader: PatchLoader,
    _graphDLC: GraphDLC,
) => {
    patchLoader.addDefinitionPatch('Game', (_module: typeof Game) => {
        return class Game extends _module {
            public pathData: PathData | null = null;
            public flexPreview: FlexPreviewState = IDLE_PREVIEW;

            private drawPath(
                render: GameRender,
                offsetX: number,
                offsetY: number,
            ) {
                const pathData = this.pathData;
                if (!pathData) return;

                const previewSteps = pathData.path;
                render.setSolidColor(0.2, 0.2, 0.8, 0.25);
                previewSteps.forEach(({ x, y }) => {
                    render.drawSolidColorRect(
                        x * this.scale + offsetX,
                        y * this.scale + offsetY,
                        this.scale,
                        this.scale,
                    );
                });

                render.startTransparentArrowsRendering();
                render.setArrowSize(this.scale);
                render.setArrowAlpha(0.5);

                previewSteps.forEach(({ x, y, type, rotation, flipped }) => {
                    render.drawArrow(
                        x * this.scale + offsetX,
                        y * this.scale + offsetY,
                        type,
                        0,
                        rotation,
                        flipped,
                    );
                });
            }

            /**
             * Marks, the Ctrl-drag destinations and the cable preview. The
             * preview is drawn translucently over the board, and the source
             * arrows underneath are never moved.
             */
            private drawFlexRouting(
                render: GameRender,
                offsetX: number,
                offsetY: number,
            ) {
                if (!flexRoutingState.isEnabled()) return;

                const cell = (x: number, y: number) => [
                    x * this.scale + offsetX,
                    y * this.scale + offsetY,
                ];

                for (const point of flexRoutingState.getMarks()) {
                    const selected = flexRoutingState.isSelected(point);
                    render.setSolidColor(
                        selected ? 0.2 : 0.95,
                        selected ? 0.65 : 0.55,
                        selected ? 1 : 0.12,
                        selected ? 0.5 : 0.35,
                    );
                    const [px, py] = cell(point.x, point.y);
                    render.drawSolidColorRect(px, py, this.scale, this.scale);
                }

                const preview = this.flexPreview;
                if (preview.status === 'idle') return;

                for (const ghost of preview.ghosts) {
                    // The marker is the destination; the arrow belongs on its
                    // feeder cell. Render them separately so the preview never
                    // implies that the arrow itself lands on the marker.
                    if (
                        ghost.marker &&
                        (ghost.marker.x !== ghost.point.x ||
                            ghost.marker.y !== ghost.point.y)
                    ) {
                        render.setSolidColor(0.95, 0.75, 0.15, 0.32);
                        const [mx, my] = cell(ghost.marker.x, ghost.marker.y);
                        render.drawSolidColorRect(mx, my, this.scale, this.scale);
                    }

                    if (ghost.blocked) {
                        render.setSolidColor(1, 0.25, 0.25, 0.5);
                    } else {
                        render.setSolidColor(0.3, 1, 0.45, 0.35);
                    }
                    const [px, py] = cell(ghost.point.x, ghost.point.y);
                    render.drawSolidColorRect(px, py, this.scale, this.scale);
                }

                const cableColor =
                    preview.status === 'failed'
                        ? [1, 0.3, 0.3, 0.3]
                        : [0.3, 0.9, 1, 0.3];
                render.setSolidColor(
                    cableColor[0],
                    cableColor[1],
                    cableColor[2],
                    cableColor[3],
                );
                for (const step of preview.steps) {
                    const [px, py] = cell(step.x, step.y);
                    render.drawSolidColorRect(px, py, this.scale, this.scale);
                }

                render.startTransparentArrowsRendering();
                render.setArrowSize(this.scale);
                render.setArrowAlpha(0.55);
                for (const step of preview.steps) {
                    const [px, py] = cell(step.x, step.y);
                    render.drawArrow(
                        px,
                        py,
                        step.type,
                        0,
                        step.rotation,
                        step.flipped,
                    );
                }
                for (const ghost of preview.ghosts) {
                    if (
                        !ghost.arrowState ||
                        ghost.point.x === ghost.marker.x &&
                            ghost.point.y === ghost.marker.y
                    ) {
                        continue;
                    }
                    const [px, py] = cell(ghost.point.x, ghost.point.y);
                    render.drawArrow(
                        px,
                        py,
                        ghost.arrowState.type,
                        0,
                        ghost.arrowState.rotation,
                        ghost.arrowState.flipped,
                    );
                }
            }

            public draw() {
                super.draw();

                const { render } = this as any as PrivateGame;
                const { offsetX, offsetY } = this.getDrawOffsets();

                render.setShowBorder(false);
                this.drawPath(render, offsetX, offsetY);
                this.drawFlexRouting(render, offsetX, offsetY);
                render.setShowBorder(true);
            }
        };
    });
};
