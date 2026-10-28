export interface ObjectPtr<T> {
    val: T;
}

// Diagnostics: which definition patches were registered and which ones ever
// matched a webpack module. Reported once after startup (see hook()).
const patchDiagnostics = {
    expected: new Set<string>(),
    applied: new Set<string>(),
    hookCalls: 0,
};

/** True once the game bundle has called the module hook (i.e. it is patched). */
export function isGameBundleHooked(): boolean {
    return patchDiagnostics.hookCalls > 0;
}

export class PatchLoader {
    private definitions: Map<string, ObjectPtr<any>>;
    private instances: Map<string, ObjectPtr<any>>;
    private patches: Array<
        (name: string, definition: any) => boolean | Function
    >;

    public constructor() {
        this.definitions = new Map();
        this.instances = new Map();
        this.patches = [];
    }

    public hook(): void {
        setTimeout(() => {
            const missing = [...patchDiagnostics.expected].filter(
                (t) => !patchDiagnostics.applied.has(t),
            );
            console.info(
                `[GraphDLC][diag] 5s after start: applied=${[...patchDiagnostics.applied].join(',') || 'none'} MISSING=${missing.join(',') || 'none'}`,
            );
        }, 5000);

        window.patchWebpackModules = (
            modules: Record<string | number, Function>,
        ) => {
            patchDiagnostics.hookCalls++;
            console.log(
                `[PatchLoader] Found ${Object.keys(modules).length} modules`,
            );
            for (const id of Object.keys(modules)) {
                const originalFn = modules[id];

                modules[id] = (module: any, exports: any, require: any) => {
                    const result = originalFn(module, exports, require);
                    const realExports = module.exports || exports;

                    if (realExports && typeof realExports === 'object') {
                        this.processExports(realExports);
                    }

                    return result;
                };
            }
            return modules;
        };
    }

    private processExports(exports: Record<string, any>): void {
        for (const key of Object.keys(exports)) {
            if (key === '__esModule') continue;

            const definition = exports[key];
            const isObject = typeof definition !== 'function';

            const modLoader = this;
            const original = definition;
            let patchedTarget: any;

            if (!isObject) {
                const isClass =
                    /^class\s/.test(
                        Function.prototype.toString.call(definition),
                    ) ||
                    /^class\{/.test(
                        Function.prototype.toString
                            .call(definition)
                            .replace(/\s/g, ''),
                    );

                if (isClass) {
                    patchedTarget = class extends original {
                        public constructor(...ctorArgs: any[]) {
                            super(...ctorArgs);
                            modLoader.setInstance(key, this);
                        }
                    };
                    Object.assign(patchedTarget, original);
                } else {
                    patchedTarget = original;
                }
            } else {
                patchedTarget = original;
            }

            patchedTarget = this.runPatches(key, patchedTarget);

            this.setDefinition(key, patchedTarget);
            exports[key] = patchedTarget;
        }
    }

    private runPatches(name: string, definition: any): any {
        const oldPatches = this.patches;
        const newPatches: typeof this.patches = [];
        this.patches = [];

        let currentDefinition = definition;

        for (const patch of oldPatches) {
            const result = patch(name, currentDefinition);

            if (result === true) {
            } else if (result === false) {
                newPatches.push(patch);
            } else if (typeof result === 'function') {
                currentDefinition = result;
            }
        }

        this.patches = newPatches;
        return currentDefinition;
    }

    public getDefinition<T = any>(name: string): ObjectPtr<T> {
        if (!this.hasDefinition(name)) {
            this.definitions.set(name, { val: null });
        }
        return this.definitions.get(name) as ObjectPtr<T>;
    }

    public setDefinition<T = any>(name: string, value: T) {
        const definition = this.definitions.get(name);
        if (!definition) {
            this.definitions.set(name, { val: value });
            return;
        }
        definition.val = value;
    }

    public hasDefinition(name: string): boolean {
        return this.definitions.has(name);
    }

    public getInstance<T = any>(name: string): ObjectPtr<T | null> {
        if (!this.hasInstance(name)) {
            this.instances.set(name, { val: null });
        }
        return this.instances.get(name) as ObjectPtr<T | null>;
    }

    public setInstance(name: string, value: any): void {
        const instance = this.instances.get(name);
        if (!instance) {
            this.instances.set(name, { val: value });
            return;
        }
        instance.val = value;
    }

    public hasInstance(name: string): boolean {
        return this.instances.has(name);
    }

    public addManualPatch(
        patch: (name: string, definition: any) => boolean | Function,
    ): void {
        this.patches.push(patch);
    }

    public addDefinitionPatch<T = any>(
        target: string,
        patch: (definition: T) => any,
    ): void {
        patchDiagnostics.expected.add(target);
        this.addManualPatch((name, definition) => {
            if (name !== target) return false;

            patchDiagnostics.applied.add(target);
            const patchResult = patch(definition as T);

            if (typeof patchResult === 'function') {
                return patchResult;
            }

            return true;
        });
    }

    public addObjectPatch<T extends object = any>(
        target: string,
        patch: (object: T, original: Readonly<T>) => void,
    ): void {
        this.addManualPatch((name, definition) => {
            if (name !== target) return false;

            const object = definition as T;
            const original = Object.create(
                Object.getPrototypeOf(object),
                Object.getOwnPropertyDescriptors(object),
            ) as T;

            patch(object, original);

            return true;
        });
    }
}

const originalElementAppend = Element.prototype.appendChild;
const originalElementInsertBefore = Element.prototype.insertBefore;
const originalDocAppend = Document.prototype.appendChild;
const originalSetAttribute = Element.prototype.setAttribute;
const originalSrcDescriptor = Object.getOwnPropertyDescriptor(
    HTMLScriptElement.prototype,
    'src',
)!;
const handledScripts = new WeakSet<HTMLScriptElement>();

// A non-JavaScript type makes the browser skip executing a <script>. Browsers
// "prepare" a script (and start fetching it) as soon as it is inserted, and
// removing it afterwards does NOT stop it from running once downloaded. So the
// native bundle.js must be neutralized at the moment its src is assigned,
// before any insertion can happen. Otherwise the unpatched bundle runs too,
// and whichever copy renders last decides whether GraphDLC's UI appears.
const INERT_SCRIPT_TYPE = 'graphdlc/intercepted';
const originalScriptTypes = new WeakMap<HTMLScriptElement, string | null>();

function isGameBundleUrl(url: string | null | undefined): url is string {
    return (
        !!url && url.includes('bundle.js') && !url.includes('bundle-shell.js')
    );
}

function neutralizeScript(script: HTMLScriptElement): void {
    if (script.getAttribute('type') === INERT_SCRIPT_TYPE) return;
    originalScriptTypes.set(script, script.getAttribute('type'));
    originalSetAttribute.call(script, 'type', INERT_SCRIPT_TYPE);
}

function toAbsoluteUrl(value: string): string | null {
    try {
        return new URL(String(value), document.baseURI).href;
    } catch {
        return null;
    }
}

// Must run BEFORE the src is assigned: setting src on a script that is already
// in the document prepares it immediately, so marking it afterwards is too late.
Object.defineProperty(HTMLScriptElement.prototype, 'src', {
    configurable: true,
    enumerable: originalSrcDescriptor.enumerable,
    get(this: HTMLScriptElement): string {
        return originalSrcDescriptor.get!.call(this);
    },
    set(this: HTMLScriptElement, value: string) {
        const absolute = toAbsoluteUrl(value);
        if (isGameBundleUrl(absolute)) neutralizeScript(this);
        originalSrcDescriptor.set!.call(this, value);
    },
});

Element.prototype.setAttribute = function (name: string, value: string): void {
    if (
        this instanceof HTMLScriptElement &&
        name.toLowerCase() === 'src' &&
        isGameBundleUrl(toAbsoluteUrl(value))
    ) {
        neutralizeScript(this);
    }
    originalSetAttribute.call(this, name, value);
};

function getScriptUrl(element: HTMLElement): string | null {
    if (element instanceof HTMLScriptElement && element.src) return element.src;
    if (element instanceof HTMLLinkElement && element.href) return element.href;
    return null;
}

function copyScriptAttributes(from: HTMLScriptElement, to: HTMLScriptElement) {
    for (let i = 0; i < from.attributes.length; i++) {
        const attr = from.attributes[i];
        if (attr.name === 'src') continue;

        if (attr.name === 'type' && attr.value === INERT_SCRIPT_TYPE) {
            // Restore the type the game asked for (or none at all).
            const original = originalScriptTypes.get(from);
            if (original) originalSetAttribute.call(to, 'type', original);
            continue;
        }

        originalSetAttribute.call(to, attr.name, attr.value);
    }
}

/**
 * Inserts the hook call into the game bundle source. Returns the code to run.
 * Shared by the dynamic (script element) path and the static-tag path.
 */
export function patchBundleCode(gameCode: string): string {
    const searchStr = 'function s';
    const lastIndex = gameCode.lastIndexOf(searchStr);

    if (lastIndex !== -1) {
        return (
            gameCode.slice(0, lastIndex) +
            '(window.patchWebpackModules(e));' +
            gameCode.slice(lastIndex)
        );
    }

    console.error(
        "[GraphDLC] hook pattern 'function s' not found in that bundle.js!",
    );
    alert("[GraphDLC] hook pattern 'function s' not found in that bundle.js!");
    return gameCode;
}

function handleScriptInjection(element: HTMLElement): boolean {
    const url = getScriptUrl(element);

    if (!isGameBundleUrl(url)) {
        return false;
    }

    if (element instanceof HTMLScriptElement) {
        if (handledScripts.has(element)) return true;
        handledScripts.add(element);
    }

    fetch(url)
        .then((res) => res.text())
        .then((gameCode) => {
            const patchedScript = document.createElement('script');
            patchedScript.textContent = `${patchBundleCode(gameCode)}\n//# sourceURL=${url.split('?')[0]}`;

            if (element instanceof HTMLScriptElement) {
                copyScriptAttributes(element, patchedScript);
            }

            const parent = document.head ?? document.documentElement;
            originalElementAppend.call(parent, patchedScript);

            // The original element never runs now, so emulate its load event
            // for shells that wait on it. The bundle has run by this point.
            if (element instanceof HTMLScriptElement) {
                element.dispatchEvent(new Event('load'));
            }
        })
        .catch((err) => {
            console.error('[GraphDLC] Error fetch-hook bundle.js:', err);
            alert(`[GraphDLC] Error fetch-hook bundle.js: ${err}`);
        });

    return true;
}

function interceptAddedScripts(root: ParentNode): void {
    const scripts: HTMLScriptElement[] = [];
    if (root instanceof HTMLScriptElement) scripts.push(root);
    scripts.push(...root.querySelectorAll('script[src]'));

    for (const script of scripts) {
        if (handleScriptInjection(script)) script.remove();
    }
}

const scriptObserver = new MutationObserver((records) => {
    for (const record of records) {
        if (record.type === 'attributes') {
            if (record.target instanceof HTMLScriptElement) {
                interceptAddedScripts(record.target);
            }
            continue;
        }

        for (const node of record.addedNodes) {
            if (node instanceof Element) interceptAddedScripts(node);
        }
    }
});

scriptObserver.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
});

Element.prototype.appendChild = function <T extends Node>(newChild: T): T {
    if (newChild instanceof HTMLElement) {
        const isIntercepted = handleScriptInjection(newChild);
        if (isIntercepted) return newChild;
    }
    return originalElementAppend.call(this, newChild) as T;
};

Element.prototype.insertBefore = function <T extends Node>(
    newChild: T,
    refChild: Node | null,
): T {
    if (newChild instanceof HTMLElement) {
        const isIntercepted = handleScriptInjection(newChild);
        if (isIntercepted) return newChild;
    }
    return originalElementInsertBefore.call(this, newChild, refChild) as T;
};

Document.prototype.appendChild = function <T extends Node>(newChild: T): T {
    if (newChild instanceof HTMLElement) {
        const isIntercepted = handleScriptInjection(newChild);
        if (isIntercepted) return newChild;
    }
    return originalDocAppend.call(this, newChild) as T;
};
