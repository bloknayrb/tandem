/**
 * Drive a real route handler without Express: register routes onto a recorder
 * app, then call the last handler for a key (the route's own body, past any
 * middleware). The shape `channel-permission-relay.test.ts` and
 * `channel-error-log-sanitization.test.ts` each grew locally; new specs import
 * this one instead of adding a copy.
 */

type Handler = (req: unknown, res: unknown, next?: unknown) => void;

export interface RecordedRes {
  _status: number;
  _body: unknown;
  status(code: number): RecordedRes;
  json(body: unknown): RecordedRes;
}

export function makeRecorderApp() {
  const routes = new Map<string, Handler[]>();
  const record =
    (method: string) =>
    (path: string, ...handlers: Handler[]) => {
      routes.set(`${method} ${path}`, handlers);
    };
  return {
    app: {
      get: record("GET"),
      post: record("POST"),
      options: record("OPTIONS"),
      delete: record("DELETE"),
    },
    routes,
  };
}

export function makeRes(): RecordedRes {
  const res: RecordedRes = {
    _status: 200,
    _body: undefined,
    status(code) {
      res._status = code;
      return res;
    },
    json(body) {
      res._body = body;
      return res;
    },
  };
  return res;
}

/** Invoke the last handler registered for `key` (e.g. `"POST /api/x"`) with `body`. */
export function callRoute(routes: Map<string, Handler[]>, key: string, body: unknown): RecordedRes {
  const handlers = routes.get(key);
  if (!handlers || handlers.length === 0) throw new Error(`no route registered for ${key}`);
  const res = makeRes();
  handlers[handlers.length - 1]!({ body }, res);
  return res;
}
