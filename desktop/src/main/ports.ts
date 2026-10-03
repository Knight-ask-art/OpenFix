import net from "node:net";

/**
 * 申请本地后端端口。传入 requestedPort 时只检查并复用该端口（被占用则拒绝），
 * 不传时按 requestedPort = 0 交给系统分配空闲端口。
 */
export function findFreePort(requestedPort = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate local port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}
