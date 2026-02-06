import { Socket } from "net";
import WebSocket from "ws";
import { ConnectData } from "./dto/ConnectData";
import { Payload } from "./dto/Payload";
import { UpdateSupportedEventsData } from "./dto/UpdateSupportedEventsData";
import parseMessage from "./parseMessage";
import axios from "axios";

const NEW_LINE = "\n".charCodeAt(0);

const defaultHeaders = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.5",
    "X-Discord-Locale": "en-GB",
    "X-Debug-Options": "bugReporterEnabled",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin"
};

export class Client {
    private websocket?: WebSocket;
    private supportedEvents: string[] = [];
    private showGuildEmoji: boolean = false;
    private token: string;

    constructor(
        private socket: Socket
    ) {}

    private createMessageReceiver = () => {
        let buffer = Buffer.alloc(0);
        this.socket.on("data", (data) => {
            let remaining = Buffer.from(data);
            let index = -1;
            while ((index = remaining.indexOf(NEW_LINE)) !== -1) {
                buffer = Buffer.concat([buffer, remaining.slice(0, index)]);
                remaining = remaining.slice(index + 1);
                this.handleMessage(buffer.toString());
                buffer = Buffer.alloc(0);
            };
            buffer = Buffer.concat([buffer, remaining]);
        });
    }

    /**
     * Handles a client connection to the TCP server.
     */
    public handleConnection = () => {
        this.createMessageReceiver();

        this.socket.on("error", this.handleClose);
        this.socket.on("end", this.handleClose);

        // console.log("Client connected.");
        this.sendObject({
            op: -1,
            t: "GATEWAY_HELLO"
        });
    }

    private handleClose = () => {
        // console.log("Client disconnected.");
        this.websocket?.close();
    }

    private handleMessage = (message: string) => {
        // console.log("Received a message from client:", message);
        try {
            const parsed = JSON.parse(message);
            if ("op" in parsed && parsed.op === -1) {
                this.handleProxyMessage(parsed);
            } else {
                if (parsed.d?.token) this.token = parsed.d?.token;
                this.websocket?.send(message);
            }
        } catch (e) {
            console.log(e);
        }
    }

    private handleProxyMessage = (payload: Payload) => {
        switch (payload.t) {
            case "GATEWAY_CONNECT":
                this.supportedEvents = (payload.d as ConnectData).supported_events;
                this.connectGateway((payload.d as ConnectData).url);
                break;
            case "GATEWAY_DISCONNECT":
                this.websocket?.close();
                break;
            case "GATEWAY_UPDATE_SUPPORTED_EVENTS":
                this.supportedEvents = (payload.d as UpdateSupportedEventsData).supported_events;
                break;
            case "GATEWAY_SHOW_GUILD_EMOJI":
                this.showGuildEmoji = Boolean(payload.d);
                break;
            case "GATEWAY_SEND_TYPING": {
                const channelId = String(payload.d);
                if (!/^\d{17,30}$/.test(channelId)) return;
                axios.post(
                    `https://discord.com/api/v9/channels/${channelId}/typing`, "",
                    {headers: {...defaultHeaders, Authorization: this.token}}
                );
                break;
            }
            default:
        }
    }

    private connectGateway = (gatewayUrl: string) => {
        this.websocket = new WebSocket(gatewayUrl)
            .on("error", e => {
                console.error(e);
                this.sendObject({
                    op: -1,
                    t: "GATEWAY_DISCONNECT",
                    d: {
                        message: e.message.toString()
                    }
                });
                this.socket.destroy();

            })
            .on("close", (code, reason) => {
                this.sendObject({
                    op: -1,
                    t: "GATEWAY_DISCONNECT",
                    d: {
                        message: reason.toString()
                    }
                });
                this.socket.destroy();
            })
            .on("unexpected-response", console.error)
            .on("message", json => {
                const jsonStr = json.toString();
                const t = jsonStr.match(/"t":"([A-Z_]+)".+/)?.[1];
                
                if (t == "READY") {
                    this.sendObject({
                        op: -1,
                        s: JSON.parse(jsonStr).s,
                        t: "J2ME_READY",
                        d: {
                            id: JSON.parse(jsonStr).d.user.id
                        }
                    })
                    if (this.supportedEvents.includes("J2ME_READ_STATES")) {
                        const entries = [];

                        JSON.parse(jsonStr).d.read_state.entries.forEach(obj => {
                            if (!obj.last_message_id) return;
                            entries.push(obj.id);
                            entries.push(obj.last_message_id);
                        })

                        this.sendObject({
                            op: -1,
                            s: JSON.parse(jsonStr).s,
                            t: "J2ME_READ_STATES",
                            d: entries
                        })
                    }
                    if (this.supportedEvents.includes("READY")) {
                        this.sendObject({
                            op: -1,
                            s: JSON.parse(jsonStr).s,
                            t: "READY",
                            d: JSON.parse(jsonStr).d
                        })
                    }
                }
                else if (
                    (t == "MESSAGE_CREATE" && this.supportedEvents.includes("J2ME_MESSAGE_CREATE")) ||
                    (t == "MESSAGE_UPDATE" && this.supportedEvents.includes("J2ME_MESSAGE_UPDATE"))
                ) {
                    this.sendObject({
                        op: -1,
                        s: JSON.parse(jsonStr).s,
                        t: "J2ME_" + t,
                        d: parseMessage(JSON.parse(jsonStr).d, this.showGuildEmoji)
                    })
                }
                else if (!t || !this.supportedEvents.length || this.supportedEvents.includes(t)) {
                    this.sendMessage(jsonStr);
                }
            });
    }

    sendMessage = (data: string) => {
        // console.log("Sending to client: " + data);
        this.socket.write(data + "\n");
    }

    sendObject = (object: any) => {
        this.sendMessage(JSON.stringify(object));
    }
}