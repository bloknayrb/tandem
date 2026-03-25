// Express 5 doesn't ship @types/express. Minimal declaration for our usage.
declare module "express" {
  function express(): any;
  namespace express {
    function json(options?: { limit?: string }): any;
  }
  export default express;
}
