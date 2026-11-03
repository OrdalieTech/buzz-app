// Stand-in for the Web Push gateway behind /webpush in production: the same
// routes, no push service and no authentication. Deliveries the relay makes
// are kept for the staging journey to read at /webpush/deliveries.
import { createServer } from "node:http";

const deliveries = [];
let grants = 0;
createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const answer = (status, json) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(json));
    };
    switch (new URL(request.url, "http://gateway").pathname) {
      case "/webpush/config":
        return answer(200, { vapidPublicKey: "staging" });
      case "/webpush/register":
        return answer(200, {
          endpoint_grant: `grant${++grants}.${JSON.parse(body).generation}`,
        });
      case "/webpush/unregister":
        return answer(200, {});
      case "/v1/deliveries/apns":
        deliveries.push(JSON.parse(body));
        return answer(200, { status: "accepted" });
      case "/webpush/deliveries":
        return answer(200, deliveries);
      default:
        return answer(404, {});
    }
  });
}).listen(8080);
