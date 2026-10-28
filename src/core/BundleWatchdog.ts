import { isGameBundleHooked } from './PatchLoader';

const RETRY_KEY = 'graphdlc-bundle-retries';
const MAX_RETRIES = 3;
const CHECK_DELAY_MS = 3000;

function readRetries(): number {
    try {
        return Number(sessionStorage.getItem(RETRY_KEY) ?? 0) || 0;
    } catch {
        return 0;
    }
}

function writeRetries(value: number | null): void {
    try {
        if (value === null) sessionStorage.removeItem(RETRY_KEY);
        else sessionStorage.setItem(RETRY_KEY, String(value));
    } catch {
        // Storage can be unavailable; the retry cap then simply isn't tracked.
    }
}

function check(): void {
    if (isGameBundleHooked()) {
        writeRetries(null);
        return;
    }

    const retries = readRetries();
    if (retries >= MAX_RETRIES) {
        console.error(
            `[GraphDLC] Game bundle was still not hooked after ${MAX_RETRIES} reloads`,
        );
        return;
    }

    writeRetries(retries + 1);
    console.warn(
        `[GraphDLC] Game bundle ran without the hook (attempt ${retries + 1}/${MAX_RETRIES}); reloading`,
    );
    location.reload();
}

/**
 * The game bundle occasionally executes before this userscript has installed
 * its hook, which leaves every GraphDLC patch unapplied. Detect that and reload.
 */
export function watchBundleHook(): void {
    const schedule = () => setTimeout(check, CHECK_DELAY_MS);
    if (document.readyState === 'complete') schedule();
    else window.addEventListener('load', schedule, { once: true });
}
