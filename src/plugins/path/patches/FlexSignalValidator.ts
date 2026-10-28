import { ArrowType } from '../../../core/utils/ArrowType';
import { getArrowRelations } from '../../../core/utils/getArrowRelations';
import { getRelativePosition } from '../../../core/utils/getRelativePosition';

export interface GridPoint {
    x: number;
    y: number;
}
export interface FlexArrowState {
    type: number;
    rotation: number;
    flipped: boolean;
}
export interface FlexSignalWrite extends FlexArrowState {
    x: number;
    y: number;
}

export interface FlexSignalRoute {
    id: string;
    /** Physical feeder-arrow cell. */
    end: GridPoint;
    /** Marker sink reached by the feeder's output; never a write location. */
    marker?: GridPoint;
}

export interface FlexSignalValidationResult {
    valid: boolean;
    reason?: string;
    source?: GridPoint;
    reached?: GridPoint;
}

const keyOf = (point: GridPoint): string => `${point.x},${point.y}`;

/**
 * Checks the final, combined wire graph using the game's actual arrow relation
 * table. This is deliberately conservative: if two requested destinations are
 * reachable from the same input, the candidate is rejected instead of silently
 * accepting a circuit that cross-connects the two routes.
 *
 * This is a connectivity check for the routing arrow network, not a simulation
 * of stateful gates, random arrows, or multi-tick game behavior.
 */
export function validateFlexSignalRoutes(
    routes: readonly FlexSignalRoute[],
    candidateWrites: readonly FlexSignalWrite[],
    stagedWrites: readonly FlexSignalWrite[],
    getLiveArrowState: (point: GridPoint) => FlexArrowState | null,
    maxVisitedPerSource = 20_000,
    allowedExistingCells: readonly GridPoint[] = [],
): FlexSignalValidationResult {
    const writes = new Map<string, FlexArrowState>();
    for (const step of stagedWrites) writes.set(keyOf(step), step);
    for (const step of candidateWrites) writes.set(keyOf(step), step);

    const read = (point: GridPoint): FlexArrowState | null => {
        const staged = writes.get(keyOf(point));
        if (staged) return staged;
        const live = getLiveArrowState(point);
        return live && live.type !== ArrowType.EMPTY ? live : null;
    };

    const markerKeys = new Set(
        routes.filter((route) => route.marker).map((route) => keyOf(route.marker!)),
    );
    // Marker coordinates are never valid arrow-write locations, even if a route
    // search accidentally included one as a start, junction, or terminal.
    for (const key of writes.keys()) {
        if (markerKeys.has(key)) {
            return {
                valid: false,
                reason: `A route attempted to place an arrow on marker ${key}`,
            };
        }
    }

    const routesBySource = new Map<
        string,
        {
            source: GridPoint;
            ends: Map<string, GridPoint>;
            markers: Map<string, GridPoint>;
        }
    >();
    const destinationOwners = new Map<string, Set<string>>();
    for (const route of routes) {
        const parts = route.id.split(',');
        if (parts.length !== 2) {
            return {
                valid: false,
                reason: `Invalid route source id: ${route.id}`,
            };
        }
        const source = { x: Number(parts[0]), y: Number(parts[1]) };
        if (!Number.isInteger(source.x) || !Number.isInteger(source.y)) {
            return {
                valid: false,
                reason: `Invalid route source id: ${route.id}`,
            };
        }
        const sourceKey = keyOf(source);
        let sourceRoutes = routesBySource.get(sourceKey);
        if (!sourceRoutes) {
            sourceRoutes = {
                source,
                ends: new Map(),
                markers: new Map(),
            };
            routesBySource.set(sourceKey, sourceRoutes);
        }
        const endKey = keyOf(route.end);
        if (route.marker && endKey === keyOf(route.marker)) {
            return {
                valid: false,
                reason: 'A feeder arrow cannot occupy its own marker cell',
                source,
            };
        }
        sourceRoutes.ends.set(endKey, route.end);
        let owners = destinationOwners.get(endKey);
        if (!owners) {
            owners = new Set();
            destinationOwners.set(endKey, owners);
        }
        owners.add(sourceKey);

        if (route.marker) {
            const markerKey = keyOf(route.marker);
            sourceRoutes.markers.set(markerKey, route.marker);
            let markerOwners = destinationOwners.get(markerKey);
            if (!markerOwners) {
                markerOwners = new Set();
                destinationOwners.set(markerKey, markerOwners);
            }
            markerOwners.add(sourceKey);

            // A feeder only represents a valid destination when its actual output
            // geometry points into the marker. Existing arrows under markers are
            // allowed; they are treated as terminal sinks by the traversal below.
            const feeder = read(route.end);
            const feedsMarker =
                feeder !== null &&
                getArrowRelations(feeder.type as ArrowType).some(
                    ([forward, sideways]) => {
                        const output = getRelativePosition(
                            route.end.x,
                            route.end.y,
                            feeder.rotation,
                            feeder.flipped,
                            forward,
                            sideways,
                        );
                        return keyOf(output) === markerKey;
                    },
                );
            if (!feedsMarker) {
                return {
                    valid: false,
                    reason: 'The terminal feeder does not output into its marker',
                    source,
                    reached: route.marker,
                };
            }
        }
    }

    // Any occupied arrow reached by a signal must belong to this proposed
    // network, a tracked cable tree, an input source, or an intended endpoint.
    // Otherwise a blue/diagonal/splitter output could silently activate an
    // unrelated live arrow while all marked destinations still look connected.
    const allowedCells = new Set<string>([
        ...writes.keys(),
        ...allowedExistingCells.map(keyOf),
        ...routesBySource.keys(),
        ...destinationOwners.keys(),
    ]);

    for (const [sourceKey, sourceRoutes] of routesBySource) {
        const queue: GridPoint[] = [sourceRoutes.source];
        const visited = new Set<string>();
        const reached = new Set<string>();
        const reachedDestinations = new Set<string>();
        while (queue.length > 0) {
            const point = queue.shift()!;
            const key = keyOf(point);
            if (visited.has(key)) continue;
            visited.add(key);
            if (visited.size > maxVisitedPerSource) {
                return {
                    valid: false,
                    reason: 'Signal connectivity search exceeded its safety limit',
                    source: sourceRoutes.source,
                };
            }

            if (destinationOwners.has(key) && read(point) !== null)
                reachedDestinations.add(key);
            if (sourceRoutes.ends.has(key) && read(point) !== null)
                reached.add(key);
            const arrow = read(point);
            if (!arrow) continue;
            // A marker is a sink for the requested route. Do not follow an
            // existing arrow beneath it onward into unrelated parts of the map.
            if (markerKeys.has(key)) continue;

            for (const [forward, sideways] of getArrowRelations(
                arrow.type as ArrowType,
            )) {
                const next = getRelativePosition(
                    point.x,
                    point.y,
                    arrow.rotation,
                    arrow.flipped,
                    forward,
                    sideways,
                );
                const nextKey = keyOf(next);
                if (destinationOwners.has(nextKey))
                    reachedDestinations.add(nextKey);
                if (read(next) !== null && !allowedCells.has(nextKey)) {
                    return {
                        valid: false,
                        reason: `Signal from ${sourceKey} would activate an unrelated existing arrow at ${nextKey}`,
                        source: sourceRoutes.source,
                        reached: next,
                    };
                }
                if (destinationOwners.has(nextKey) && read(next) !== null)
                    reachedDestinations.add(nextKey);
                if (sourceRoutes.ends.has(nextKey) && read(next) !== null)
                    reached.add(nextKey);
                if (
                    read(next) !== null &&
                    !markerKeys.has(nextKey) &&
                    !visited.has(nextKey)
                ) {
                    queue.push(next);
                }
            }
        }

        for (const [endKey, end] of sourceRoutes.ends) {
            if (!reached.has(endKey)) {
                return {
                    valid: false,
                    reason: 'A staged cable no longer reaches its intended feeder',
                    source: sourceRoutes.source,
                    reached: end,
                };
            }
        }
        for (const [markerKey, marker] of sourceRoutes.markers) {
            if (!reachedDestinations.has(markerKey)) {
                return {
                    valid: false,
                    reason: 'A staged feeder no longer reaches its marker',
                    source: sourceRoutes.source,
                    reached: marker,
                };
            }
        }

        // Destinations belonging to this same source are intentional branches.
        // Reaching a destination owned by another source is a cross-connection.
        for (const reachedKey of reachedDestinations) {
            const owners = destinationOwners.get(reachedKey);
            if (owners && [...owners].some((owner) => owner !== sourceKey)) {
                return {
                    valid: false,
                    reason: `Signal from ${sourceKey} also reaches another source's destination ${reachedKey}`,
                    source: sourceRoutes.source,
                    reached: {
                        x: Number(reachedKey.split(',')[0]),
                        y: Number(reachedKey.split(',')[1]),
                    },
                };
            }
        }
    }

    return { valid: true };
}
