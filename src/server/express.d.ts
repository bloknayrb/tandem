// Express 5 doesn't ship @types/express and its bundled index.d.ts depends on
// express-serve-static-core (not installed). This minimal ambient declaration
// covers only the subset we actually use: app factory, JSON body parser, and
// the core request/response/middleware shapes.
declare module "express" {
  interface Request {
    body: unknown;
    headers: Record<string, string | string[] | undefined>;
    params: Record<string, string>;
    method: string;
    path: string;
  }

  interface Response {
    status(code: number): Response;
    json(body: unknown): void;
    header(name: string, value: string): void;
    setHeader(name: string, value: string): void;
    sendStatus(code: number): void;
    end(): void;
  }

  type NextFunction = (err?: unknown) => void;

  interface Application {
    // biome-ignore lint/suspicious/noExplicitAny: Express overloads are too complex to replicate without @types/express
    use(...args: any[]): Application;
    // biome-ignore lint/suspicious/noExplicitAny: see above
    post(path: string, ...handlers: any[]): Application;
    // biome-ignore lint/suspicious/noExplicitAny: see above
    get(path: string, ...handlers: any[]): Application;
    // biome-ignore lint/suspicious/noExplicitAny: see above
    options(path: string, ...handlers: any[]): Application;
    // biome-ignore lint/suspicious/noExplicitAny: see above
    delete(path: string, ...handlers: any[]): Application;
    listen(port: number, host: string, callback?: () => void): import("http").Server;
  }

  function express(): Application;

  namespace express {
    function json(options?: {
      limit?: string;
    }): (req: Request, res: Response, next: NextFunction) => void;
  }

  export default express;
  export { Request, Response, NextFunction, Application };
}
