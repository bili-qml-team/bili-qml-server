import { env } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";
import app from "./server.mts"


app.listen(3000);
export default httpServerHandler({ port: 3000 });