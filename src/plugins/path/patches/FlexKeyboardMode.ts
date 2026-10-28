/**
 * The flex shortcut handler must only own keyboard input while B mode is active.
 * Keep this decision independent from the DOM so its pass-through behavior can
 * be regression-tested without a browser.
 */
export function isFlexRoutingModeActive(
    routingEnabled: boolean,
    triggerEnabled: boolean,
): boolean {
    return routingEnabled && triggerEnabled;
}

/** B toggles the mode; every other key belongs to flex only while it is active. */
export function shouldDispatchFlexKey(
    code: string,
    flexModeActive: boolean,
): boolean {
    return code === 'KeyB' || flexModeActive;
}
