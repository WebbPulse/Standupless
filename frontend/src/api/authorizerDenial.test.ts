/**
 * The gateway's authorizer denial must reach the shared client as a 401, so
 * it refreshes and replays, while every other answer passes through as sent.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  isGatewayDenialBody,
  withAuthorizerDenialAsUnauthorized,
} from './authorizerDenial';

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'apigw-requestid': 'abc' },
  });

const bearer = { headers: { Authorization: 'Bearer a.b.c' } };

describe('isGatewayDenialBody', () => {
  it('matches only the gateway body', () => {
    expect(isGatewayDenialBody('{"message":"Forbidden"}')).toBe(true);
    expect(
      isGatewayDenialBody(
        '{"success":false,"status":403,"message":"Forbidden","request_id":"r"}'
      )
    ).toBe(false);
    expect(isGatewayDenialBody('{"message":"Not a member"}')).toBe(false);
    expect(isGatewayDenialBody('not json')).toBe(false);
    expect(isGatewayDenialBody('["Forbidden"]')).toBe(false);
    expect(isGatewayDenialBody('')).toBe(false);
  });
});

describe('withAuthorizerDenialAsUnauthorized', () => {
  it('turns a gateway denial of a bearer request into a 401 with the same body', async () => {
    const wrapped = withAuthorizerDenialAsUnauthorized(
      vi.fn(() => Promise.resolve(json({ message: 'Forbidden' }, 403)))
    );

    const response = await wrapped('https://api.test/workspaces', bearer);

    expect(response.status).toBe(401);
    expect(response.headers.get('apigw-requestid')).toBe('abc');
    await expect(response.json()).resolves.toEqual({ message: 'Forbidden' });
  });

  it('reads the bearer from a Request as well as from init', async () => {
    const wrapped = withAuthorizerDenialAsUnauthorized(
      vi.fn(() => Promise.resolve(json({ message: 'Forbidden' }, 403)))
    );

    const response = await wrapped(
      new Request('https://api.test/workspaces', bearer)
    );

    expect(response.status).toBe(401);
  });

  it('leaves a denial of a request with no bearer as a 403', async () => {
    const wrapped = withAuthorizerDenialAsUnauthorized(
      vi.fn(() => Promise.resolve(json({ message: 'Forbidden' }, 403)))
    );

    const response = await wrapped('https://api.test/workspaces');

    expect(response.status).toBe(403);
  });

  it('leaves a backend 403 untouched and still readable', async () => {
    const body = {
      success: false,
      status: 403,
      message: 'Forbidden',
      request_id: 'r',
    };
    const wrapped = withAuthorizerDenialAsUnauthorized(
      vi.fn(() => Promise.resolve(json(body, 403)))
    );

    const response = await wrapped('https://api.test/workspaces', bearer);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(body);
  });

  it('passes every other status through', async () => {
    const original = json({ message: 'Forbidden' }, 404);
    const wrapped = withAuthorizerDenialAsUnauthorized(
      vi.fn(() => Promise.resolve(original))
    );

    await expect(wrapped('https://api.test/x', bearer)).resolves.toBe(original);
  });
});
