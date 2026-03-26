// Express 5 doesn't ship @types/express and its bundled index.d.ts depends on
// express-serve-static-core (not installed). This minimal ambient declaration
// covers only the subset we actually use: app factory, JSON body parser, and
// the core request/response/middleware shapes.
//
// Request extends IncomingMessage and Response extends ServerResponse so our
// types are assignable to the MCP SDK's handleRequest(req, res, body) signature.
declare module "express" {
  import { IncomingMessage, ServerResponse } from "http";

  interface Request extends IncomingMessage {
    body: unknown;
    params: Record<string, string>;
    method: string; // narrows IncomingMessage's string | undefined
    path: string; // Express-only (IncomingMessage has url, not path)
  }

  interface Response extends ServerResponse {
    status(code: number): Response;
    json(body: unknown): void;
    header(name: string, value: string): void;
    sendStatus(code: number): void;
  }

  type NextFunction = (err?: unknown) => void;

  // biome-ignore lint/suspicious/noExplicitAny: Express overloads are too complex to replicate without @types/express
  type RouteHandler = any;

  interface Application {
    use(...args: RouteHandler[]): Application;
    post(path: string, ...handlers: RouteHandler[]): Application;
    get(path: string, ...handlers: RouteHandler[]): Application;
    options(path: string, ...handlers: RouteHandler[]): Application;
    delete(path: string, ...handlers: RouteHandler[]): Application;
    listen(port: number, host: string, callback?: () => void): import("http").Server;
  }

  type Express = Application;

  function express(): Application;

  namespace express {
    function json(options?: {
      limit?: string;
    }): (req: Request, res: Response, next: NextFunction) => void;
  }

  export default express;
  export { Request, Response, NextFunction, Application, Express };
}
