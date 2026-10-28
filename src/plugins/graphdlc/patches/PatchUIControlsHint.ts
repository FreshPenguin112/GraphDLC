import type { PlayerAccess } from '@logic-arrows/player/player-access';
import type { UIControlsHint } from '@logic-arrows/ui/components/ui-controls-hint';
import type { GraphDLC } from 'src/core/GraphDLC';
import type { PatchLoader } from 'src/core/PatchLoader';
import type { ControlsState, KeyBindHint } from 'src/plugins/core/Plugin';
import type { IPatcher } from '../../Patcher';

const replaceInlineKeys = (match: string): string => {
    match = match.replace('#', '').replace('(', '').replace(')', '');
    return `<span class="inline-key-blue">${match}</span>`;
};

const inlineKeysRegex: RegExp = /(#(\w+))|(#\(.+?\))/gm;

function inlineKeys(rawText: string): string {
    return rawText.replace(inlineKeysRegex, replaceInlineKeys);
}

function isHintVisible(keybindHint: KeyBindHint): boolean {
    if (!keybindHint.triggers) return true;
    return keybindHint.triggers.every((trigger) => trigger.value);
}

function filterByState(
    state: ControlsState,
    keybindHints: KeyBindHint[],
): KeyBindHint[] {
    return keybindHints.filter(
        (keybindHint) =>
            keybindHint.showOn.includes(state) && isHintVisible(keybindHint),
    );
}

function makeHints(keybindHints: KeyBindHint[]): string {
    return inlineKeys(
        keybindHints
            .map((hint) => {
                const keys = hint.keys
                    .map((key) => (typeof key === 'string' ? key : key.get()))
                    .join(' + ');
                return `<p>#(${keys}) ${hint.description.get()}</p>`;
            })
            .join(''),
    );
}

interface PrivateUIControlsHint {
    hint: HTMLElement;
    rights: PlayerAccess;
    state: ControlsState;
}

export const PatchUIControlsHint: IPatcher = (
    patchLoader: PatchLoader,
    graphDLC: GraphDLC,
) => {
    patchLoader.addDefinitionPatch(
        'UIControlsHint',
        (_module: typeof UIControlsHint) => {
            const keybindHints = graphDLC.pluginManager.gatherKeybindHints();
            let controlsHint: UIControlsHint | null = null;

            // Triggers can change while the pointer remains in the same control
            // state (e.g. pressing B to enter flex mode). Refresh the extension
            // hints directly instead of asking setState to change to itself.
            keybindHints.forEach((keybindHint) => {
                keybindHint.triggers?.forEach((trigger) => {
                    trigger.add(() => {
                        const hint = controlsHint as unknown as {
                            refreshGraphDlcHints?: () => void;
                        } | null;
                        hint?.refreshGraphDlcHints?.();
                    });
                });
            });

            return class UIControlsHint extends _module {
                public constructor(parent: HTMLElement, rights: PlayerAccess) {
                    super(parent, rights);
                    controlsHint = this;
                    // Keep extension hints compact and click-through. The base game
                    // styles paragraphs as full-size stacked rows, which made the
                    // flex instructions cover the board and intercept clicks.
                    if (
                        !document.getElementById('graphdlc-compact-hints-style')
                    ) {
                        const style = document.createElement('style');
                        style.id = 'graphdlc-compact-hints-style';
                        style.textContent = `
                            .graphdlc-keybind-hints {
                                display: flex !important;
                                flex-flow: row wrap !important;
                                align-items: center !important;
                                gap: 2px 8px !important;
                                width: max-content !important;
                                max-width: min(420px, 42vw) !important;
                                max-height: 34px !important;
                                overflow: hidden !important;
                                padding: 2px 4px !important;
                                margin: 2px 0 !important;
                                font-size: 10px !important;
                                line-height: 1.15 !important;
                                pointer-events: none !important;
                                user-select: none !important;
                            }
                            .graphdlc-keybind-hints p {
                                display: inline !important;
                                width: auto !important;
                                max-width: 100% !important;
                                margin: 0 !important;
                                padding: 0 !important;
                                font-size: 10px !important;
                                line-height: 1.15 !important;
                            }
                            .graphdlc-keybind-hints .inline-key-blue {
                                font-size: 10px !important;
                                padding: 0 2px !important;
                            }
                        `;
                        document.head.appendChild(style);
                    }
                }

                private refreshGraphDlcHints(): void {
                    const self = this as unknown as PrivateUIControlsHint;
                    // Keep our hints separate from the game's native hint DOM so
                    // refreshing does not erase or duplicate native keybinds.
                    self.hint
                        .querySelectorAll(':scope > .graphdlc-keybind-hints')
                        .forEach((element) => element.remove());
                    if (!self.rights.canOpenMenu) return;

                    const html = makeHints(
                        filterByState(self.state, keybindHints),
                    );
                    if (!html) return;

                    const wrapper = document.createElement('div');
                    wrapper.className = 'graphdlc-keybind-hints';
                    wrapper.innerHTML = html;
                    self.hint.appendChild(wrapper);
                }

                public updateRights(rights: PlayerAccess): void {
                    super.updateRights(rights);
                    this.refreshGraphDlcHints();
                }

                public setState(
                    state: 'none' | 'free' | 'arrow' | 'selected',
                ): void {
                    // Avoid forcing the base class through a redundant state
                    // transition, but refresh extension hints even on no-op
                    // transitions because a ReactiveValue trigger may have changed.
                    const currentState = (
                        this as unknown as PrivateUIControlsHint
                    ).state;
                    if (currentState !== state) super.setState(state);
                    this.refreshGraphDlcHints();
                }
            };
        },
    );
};
