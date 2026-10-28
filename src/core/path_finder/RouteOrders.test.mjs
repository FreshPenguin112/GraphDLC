import assert from 'node:assert/strict';
import test from 'node:test';
import { getRouteOrderCandidates } from './RouteOrders.ts';

const span = (startX, startY, endX, endY) => ({ startX, startY, endX, endY });

test('tries several distinct route orders, starting longest-first', () => {
    const routes = [span(0, 0, 2, 0), span(0, 0, 9, 0), span(0, 0, 5, 0)];
    const orders = getRouteOrderCandidates(routes);
    assert.deepEqual(orders[0], [1, 2, 0]);
    assert.ok(orders.some((order) => order.join(',') === '0,2,1'));
    assert.ok(orders.some((order) => order.join(',') === '0,1,2'));
    assert.ok(orders.length > 3, 'failed arrangements get more than three attempts');
    assert.equal(new Set(orders.map((order) => order.join(','))).size, orders.length);
});

test('route order candidates remain unique even for equal-length routes', () => {
    const routes = [span(0, 0, 3, 0), span(0, 0, 3, 0)];
    const orders = getRouteOrderCandidates(routes);
    assert.ok(orders.length >= 1);
    assert.equal(new Set(orders.map((order) => order.join(','))).size, orders.length);
});

test('a single route has exactly one order', () => {
    assert.deepEqual(getRouteOrderCandidates([span(0, 0, 1, 1)]), [[0]]);
});
