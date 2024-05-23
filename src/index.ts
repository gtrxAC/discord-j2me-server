import { createServer } from 'net';
import { Client } from "./Client";

const { PORT = 8081 } = process.env;

const server = createServer((socket) => {
    new Client(socket).handleConnection()
})

server.listen(PORT, () => {
    console.log(`TCP server is listening on port ${PORT}.`);
});