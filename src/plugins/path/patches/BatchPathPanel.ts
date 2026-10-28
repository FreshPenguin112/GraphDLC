import type { GameMap } from '@logic-arrows/game-logic/game-map';
import type { PathStep } from 'src/core/path_finder/types';
import type { BatchConnectionGroup, GridPoint } from './types';

export class BatchPathPanel {
    private readonly element: HTMLDivElement;
    private readonly onClose: () => void;
    private readonly gameMap: GameMap;
    private readonly planner: BatchPathPlanner;
    private groups: BatchConnectionGroup[] = [];
    private selectedInput: GridPoint | null = null;
    private selectedOutputs: GridPoint[] = [];
    private currentStep: 'select-input' | 'select-outputs' | 'preview' | 'apply' | 'cancel' = 'select-input';
    private readonly onApply: (routes: PathStep[][], groups: BatchConnectionGroup[]) => void;
    private readonly onCancel: () => void;

    private inputRows: HTMLDivElement[];
    private outputContainers: HTMLDivElement[][];
    private statusDiv: HTMLDivElement;
    private previewDiv: HTMLDivElement;
    private applyButton: HTMLButtonElement;
    private cancelButton: HTMLButtonElement;

    public constructor(
        onClose: () => void,
        onApply: (routes: PathStep[][], groups: BatchConnectionGroup[]) => void,
        onCancel: () => void,
        gameMap: GameMap,
        planner: BatchPathPlanner,
    ) {
        this.onClose = onClose;
        this.onApply = onApply;
        this.onCancel = onCancel;
        this.gameMap = gameMap;
        this.planner = planner;

        this.element = document.createElement('div');
        this.element.id = 'batch-path-panel';
        this.element.style.position = 'fixed';
        this.element.style.top = '20px';
        this.element.style.left = '20px';
        this.element.style.right = '20px';
        this.element.style.bottom = '20px';
        this.element.style.backgroundColor = 'rgba(30, 30, 30, 0.95)';
        this.element.style.color = '#fff';
        this.element.style.padding = '20px';
        this.element.style.borderRadius = '8px';
        this.element.style.zIndex = '1000';
        this.element.style.maxWidth = 'calc(100vw - 40px)';
        this.element.style.maxHeight = 'calc(100vh - 40px)';
        this.element.style.overflow = 'auto';
        this.element.style.fontFamily = 'sans-serif';

        this.inputRows = [];
        this.outputContainers = [];

        this._buildUI();

        this._updatePanel();
    }

    private _buildUI(): void {
        const header = document.createElement('div');
        header.style.marginBottom = '15px';
        header.style.borderBottom = '1px solid #555';
        header.style.paddingBottom = '10px';
        header.style.fontSize = '1.2em';

        const title = document.createElement('span');
        title.textContent = 'Batch Path';
        title.style.marginRight = '10px';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.float = 'right';
        closeBtn.style.background = 'none';
        closeBtn.style.border = 'none';
        closeBtn.style.color = '#fff';
        closeBtn.style.fontSize = '1.5em';
        closeBtn.style.cursor = 'pointer';
        closeBtn.addEventListener('click', () => this.onClose());

        header.appendChild(title);
        header.appendChild(closeBtn);
        this.element.appendChild(header);

        const controls = document.createElement('div');
        controls.style.margin = '15px 0';
        controls.style.display = 'flex';
        controls.style.flexDirection = 'column';

        const addInputBtn = document.createElement('button');
        addInputBtn.textContent = 'Add Input';
        addInputBtn.style.marginBottom = '5px';
        addInputBtn.addEventListener('click', () => this._addInput());
        controls.appendChild(addInputBtn);

        const previewBtn = document.createElement('button');
        previewBtn.textContent = 'Preview Routes';
        previewBtn.style.marginBottom = '5px';
        previewBtn.addEventListener('click', () => this._previewRoutes());
        controls.appendChild(previewBtn);

        const applyBtn = document.createElement('button');
        applyBtn.textContent = 'Apply Routes';
        applyBtn.style.marginBottom = '5px';
        applyBtn.disabled = true;
        applyBtn.addEventListener('click', () => this._applyRoutes());
        this.applyButton = applyBtn;
        controls.appendChild(applyBtn);

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.marginBottom = '5px';
        cancelBtn.addEventListener('click', () => this.onCancel());
        controls.appendChild(cancelBtn);

        this.element.appendChild(controls);

        const groupsDiv = document.createElement('div');
        groupsDiv.style.marginTop = '15px';
        groupsDiv.style.minHeight = '150px';
        this.element.appendChild(groupsDiv);
        this._renderGroups(groupsDiv);

        const statusBar = document.createElement('div');
        statusBar.style.marginTop = '10px';
        statusBar.style.fontSize = '0.8em';
        statusBar.style.color = '#aaa';
        this.statusDiv = statusBar;
        this.element.appendChild(statusBar);

        this.element.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
        });

        document.addEventListener('click', (e: MouseEvent) => {
            if ((e.target as Node).isSameNode(this.element) || this.element.contains(e.target)) return;
            this.onCancel();
        });
    }

    private _renderGroups(container: HTMLDivElement): void {
        container.innerHTML = '';

        if (this.groups.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.textContent = 'No input groups defined. Click "Add Input" to start.';
            emptyMsg.style.color = '#888';
            emptyMsg.style.fontStyle = 'italic';
            container.appendChild(emptyMsg);
            return;
        }

        for (let g = 0; g < this.groups.length; g += 1) {
            const group = this.groups[g];
            const groupDiv = document.createElement('div');
            groupDiv.style.marginBottom = '10px';
            groupDiv.style.paddingBottom = '8px';
            groupDiv.style.borderBottom = '1px solid #555';

            const groupHeader = document.createElement('div');
            groupHeader.style.display = 'flex';
            groupHeader.style.justifyContent = 'space-between';
            groupHeader.style.alignItems = 'center';
            groupHeader.style.marginBottom = '5px';

            const inputLabel = document.createElement('span');
            inputLabel.textContent = `Input ${g + 1} at (${group.input.x}, ${group.input.y})`;
            inputLabel.style.fontWeight = 'bold';

            const removeBtn = document.createElement('button');
            removeBtn.textContent = 'Remove';
            removeBtn.style.fontSize = '0.7em';
            removeBtn.addEventListener('click', () => this._removeGroup(g));
            groupHeader.appendChild(inputLabel);
            groupHeader.appendChild(removeBtn);
            groupDiv.appendChild(groupHeader);

            const outputsDiv = document.createElement('div');
            outputsDiv.style.display = 'grid';
            outputsDiv.style.gridTemplateColumns = 'repeat(auto-fit, minmax(50px, 1fr))';
            outputsDiv.style.gap = '5px';

            this.outputContainers[g] = outputsDiv;

            for (let o = 0; o < group.outputs.length; o += 1) {
                const output = group.outputs[o];
                const outputDiv = document.createElement('div');
                outputDiv.textContent = `Out ${o + 1}: (${output.x}, ${output.y})`;
                outputDiv.style.backgroundColor = '#444';
                outputDiv.style.color = '#fff';
                outputDiv.style.padding = '3px';
                outputDiv.style.borderRadius = '4px';
                outputDiv.style.minWidth = '60px';
                outputDiv.style.textAlign = 'center';
                outputsDiv.appendChild(outputDiv);
            }

            groupDiv.appendChild(outputsDiv);
            container.appendChild(groupDiv);
        }
    }

    private _updatePanel(): void {
        this._renderGroups(this.element.querySelectorAll('div')[0]?.parentElement as HTMLDivElement || this.element);

        const isReady = this._isApplyEnabled();
        this.applyButton.disabled = !isReady;
    }

    private _isApplyEnabled(): boolean {
        if (this.groups.length === 0) return false;
        for (const group of this.groups) {
            if (group.outputs.length === 0) return false;
        }
        return true;
    }

    private _addInput(): {
        input: GridPoint;
        outputs: GridPoint[];
    } {
        // For now, ask user to click on the board to select an input
        // In a full implementation, this would show a prompt or use mouse targeting
        // For this prototype, we'll add a group with placeholder coordinates
        const newGroup: BatchConnectionGroup = {
            input: { x: 0, y: 0 },
            outputs: [],
        };
        this.groups.push(newGroup);
        this._updatePanel();
        return newGroup;
    }

    private _removeGroup(groupIdx: number): void {
        this.groups.splice(groupIdx, 1);
        this._updatePanel();
    }

    private _previewRoutes(): void {
        // Run the planner
        const planner = new (await import('src/core/path_finder/BatchPathPlanner')).BatchPathPlanner(
            this.gameMap,
            this.groups,
        );

        // The planner's step() method needs to be called in a loop
        // For this prototype, we'll run it synchronously with a timeout
        const maxIterations = 1000;
        let iterations = 0;

        while (iterations < maxIterations && !planner.isDone) {
            planner.step(40);
            iterations += 1;
        }

        const result = planner.getResult();

        if (result && result.status.success) {
            this._showPreview(result.routes, result.groups);
            this.currentStep = 'preview';
            this._updatePanel();
        } else {
            this._showError(result?.status.error || 'Planning failed');
            this.currentStep = 'select-input';
            this._updatePanel();
        }
    }

    private _showPreview(routes: PathStep[][], groups: BatchConnectionGroup[]): void {
        this.previewDiv = document.createElement('div');
        this.previewDiv.style.position = 'fixed';
        this.previewDiv.style.top = '20px';
        this.previewDiv.style.left = '200px';
        this.previewDiv.style.right = '20px';
        this.previewDiv.style.bottom = '20px';
        this.previewDiv.style.backgroundColor = 'rgba(20, 50, 20, 0.95)';
        this.previewDiv.style.color = '#fff';
        this.previewDiv.style.padding = '20px';
        this.previewDiv.style.borderRadius = '8px';
        this.previewDiv.style.zIndex = '1001';
        this.previewDiv.style.overflow = 'auto';
        this.previewDiv.style.fontFamily = 'sans-serif';

        const title = document.createElement('div');
        title.textContent = 'Route Preview - Planning Successful';
        title.style.marginBottom = '15px';
        title.style.paddingBottom = '8px';
        title.style.borderBottom = '1px solid #44ff44';
        title.style.fontSize = '1.2em';
        this.previewDiv.appendChild(title);

        const routesDiv = document.createElement('div');
        routesDiv.style.maxHeight = '400px';
        routesDiv.style.overflow = 'auto';

        for (let g = 0; g < groups.length; g += 1) {
            const groupDiv = document.createElement('div');
            groupDiv.style.marginBottom = '15px';
            groupDiv.style.paddingBottom = '8px';
            groupDiv.style.borderBottom = '1px solid #555';

            const groupTitle = document.createElement('div');
            groupTitle.textContent = `Input group ${g + 1} at (${groups[g].input.x}, ${groups[g].input.y})`;
            groupTitle.style.fontWeight = 'bold';
            groupTitle.style.marginBottom = '5px';
            groupDiv.appendChild(groupTitle);

            const routeDiv = document.createElement('div');
            routeDiv.style.display = 'grid';
            routeDiv.style.gridTemplateColumns = 'repeat(auto-fit, minmax(50px, 1fr))';
            routeDiv.style.gap = '5px';

            for (let r = 0; r < routes.length; r += 1) {
                // Simple representation - just show the path steps
                const path = routes[r];
                const stepDiv = document.createElement('div');
                stepDiv.textContent = `Path ${r + 1}: ${path.length} steps`;
                stepDiv.style.backgroundColor = '#224422';
                stepDiv.style.color = '#aaffaa';
                stepDiv.style.padding = '3px';
                stepDiv.style.borderRadius = '3px';
                stepDiv.style.minWidth = '60px';
                stepDiv.style.textAlign = 'center';
                routeDiv.appendChild(stepDiv);
            }

            groupDiv.appendChild(routeDiv);
            routesDiv.appendChild(groupDiv);
        }

        this.previewDiv.appendChild(routesDiv);

        const buttonsDiv = document.createElement('div');
        buttonsDiv.style.marginTop = '15px';
        buttonsDiv.style.display = 'flex';
        buttonsDiv.gap = '10px';

        const applyBtn = document.createElement('button');
        applyBtn.textContent = 'Apply';
        applyBtn.addEventListener('click', () => this._commitPreview(routes, groups));
        buttonsDiv.appendChild(applyBtn);

        const cancelPreviewBtn = document.createElement('button');
        cancelPreviewBtn.textContent = 'Cancel';
        cancelPreviewBtn.addEventListener('click', () => {
            this._removePreview();
            this._updatePanel();
        });
        buttonsDiv.appendChild(cancelPreviewBtn);

        this.previewDiv.appendChild(buttonsDiv);
        document.body.appendChild(this.previewDiv);
    }

    private _commitPreview(routes: PathStep[][], groups: BatchConnectionGroup[]): void {
        // Apply the routes to the game map
        // This is a simplified version - full implementation would write arrows to the map
        for (let g = 0; g < groups.length; g += 1) {
            const groupRoutes = routes[g] || [];
            for (const path of groupRoutes) {
                for (const step of path) {
                    const arrow = this.gameMap.getArrow(step.x, step.y);
                    if (arrow) {
                        arrow.type = step.type;
                        arrow.rotation = step.rotation;
                        arrow.flipped = step.flipped;
                        this.gameMap.updateArrowState(arrow, /* chunk */ null, step.x, step.y);
                    }
                }
            }
        }

        // Record history changes
        // ... (full implementation would use game history)

        // Close the panel
        this._removePreview();
        this.onApply(routes, groups);
        this.onClose();
    }

    private _removePreview(): void {
        if (this.previewDiv && this.previewDiv.parentNode) {
            this.previewDiv.parentNode.removeChild(this.previewDiv);
        }
        this.previewDiv = null;
    }

    private _showError(message: string): void {
        this.statusDiv.textContent = `Error: ${message}`;
        this.statusDiv.style.color = '#ffaaaa';
    }

    public getElement(): HTMLDivElement {
        return this.element;
    }
}