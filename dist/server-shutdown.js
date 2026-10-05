// Longer than the longest tool-call yield (30 s), so in-flight calls finish.
const HTTP_DRAIN_TIMEOUT_MS = 35_000;
// Drain HTTP before closing application state: stop accepting connections,
// let in-flight requests finish, then close the stores they depend on.
export async function shutdownHttpServer(httpServer, closeApplication) {
    const httpClosed = new Promise((resolve, reject) => {
        httpServer.close((error) => {
            if (error)
                reject(error);
            else
                resolve();
        });
    });
    httpServer.closeIdleConnections();
    // Connections that finish their in-flight request become idle; close them
    // promptly instead of waiting for the keep-alive timeout.
    const idleSweep = setInterval(() => httpServer.closeIdleConnections(), 250);
    const drainDeadline = setTimeout(() => httpServer.closeAllConnections(), HTTP_DRAIN_TIMEOUT_MS);
    try {
        await httpClosed;
    }
    finally {
        clearInterval(idleSweep);
        clearTimeout(drainDeadline);
        await closeApplication();
    }
}
