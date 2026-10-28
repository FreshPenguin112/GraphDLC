/**
 * Pure frame-state policy for flex marker drags.
 *
 * A live drag owns the board frame, but an already released preview must not
 * swallow the game's update loop. While that preview is pending, starting a
 * new Ctrl-drag from a selected mark replaces the candidate; otherwise the
 * preview remains pending and normal controls/rendering continue.
 */
export type FlexDragFrameAction =
    | 'start-drag'
    | 'update-drag'
    | 'drop-drag'
    | 'keep-pending'
    | 'idle';

export function getFlexDragFrameAction(
    dragActive: boolean,
    dropPending: boolean,
    dragGesture: boolean,
    cursorSelected: boolean,
): FlexDragFrameAction {
    if (dropPending) {
        return dragGesture && cursorSelected ? 'start-drag' : 'keep-pending';
    }
    if (dragActive) return dragGesture ? 'update-drag' : 'drop-drag';
    if (dragGesture && cursorSelected) return 'start-drag';
    return 'idle';
}
