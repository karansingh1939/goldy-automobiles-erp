/**
 * Express handler that sends what fn returns as JSON with the given status.
 * Errors, thrown or rejected, go to the error handler. A handler that sends
 * its own response (a file, CSV) returns nothing.
 */
export const respond =
  (fn, status = 200) =>
  async (req, res, next) => {
    try {
      const body = await fn(req, res);
      if (body !== undefined && !res.headersSent) res.status(status).json(body);
    } catch (error) {
      next(error);
    }
  };

/** Like respond, wrapping the result as { data }. */
export const respondData = (fn, status = 200) =>
  respond(async (req, res) => ({ data: await fn(req, res) }), status);
