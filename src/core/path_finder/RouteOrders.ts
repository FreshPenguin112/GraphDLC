export interface RouteSpan {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
}

function spanLength(route: RouteSpan): number {
    return (
        Math.abs(route.endX - route.startX) +
        Math.abs(route.endY - route.startY)
    );
}

/**
 * Orders in which a set of routes is attempted. Routing the longest routes
 * first usually leaves room for the short ones; the opposite order and the
 * given order are fallbacks for layouts where the first choice blocks a
 * later route. Returned orders are index permutations, without duplicates.
 */
export function getRouteOrderCandidates(
    routes: readonly RouteSpan[],
): number[][] {
    const indices = routes.map((_, index) => index);
    if (indices.length <= 1) return indices.length ? [indices] : [[]];

    const span = (index: number) => spanLength(routes[index]);
    const farFirst = [...indices].sort((a, b) => span(b) - span(a) || a - b);
    const nearFirst = [...indices].sort((a, b) => span(a) - span(b) || a - b);
    const alternating = [...farFirst].sort((a, b) => {
        const ai = farFirst.indexOf(a);
        const bi = farFirst.indexOf(b);
        const ar =
            ai % 2 === 0 ? ai / 2 : farFirst.length - 1 - Math.floor(ai / 2);
        const br =
            bi % 2 === 0 ? bi / 2 : farFirst.length - 1 - Math.floor(bi / 2);
        return ar - br;
    });

    // Route order can decide whether a set of cables fits at all. Try a wider
    // set of deterministic orders before declaring the whole preview unroutable.
    // Keep the cap bounded: exhaustive permutations become factorial very quickly.
    const candidates: number[][] = [];
    const seen = new Set<string>();
    const add = (order: number[]) => {
        const signature = order.join(',');
        if (order.length === indices.length && !seen.has(signature)) {
            seen.add(signature);
            candidates.push(order);
        }
    };

    add(farFirst);
    add(nearFirst);
    add(indices);
    add(alternating);
    add([...alternating].reverse());

    // Rotating the longest-first order changes which similarly long cable gets
    // the most room first; reverse rotations provide a second family of retries.
    const maxRotations = Math.min(indices.length, 8);
    for (let offset = 1; offset < maxRotations; offset += 1) {
        add([...farFirst.slice(offset), ...farFirst.slice(0, offset)]);
        add(
            [
                ...farFirst.slice(-offset),
                ...farFirst.slice(0, -offset),
            ].reverse(),
        );
    }

    // A second interleaving prioritizes long routes but gives short routes a
    // chance to claim constrained cells earlier on alternating attempts.
    for (let offset = 1; offset < Math.min(indices.length, 5); offset += 1) {
        add([...farFirst.slice(offset), ...nearFirst.slice(0, offset)]);
        add([...nearFirst.slice(offset), ...farFirst.slice(0, offset)]);
    }

    return candidates;
}
