import { Socket } from "net";
import WebSocket from "ws";
import { ConnectData } from "./dto/ConnectData";
import { Payload } from "./dto/Payload";
import { UpdateSupportedEventsData } from "./dto/UpdateSupportedEventsData";
import parseMessage from "./parseMessage";
import axios from "axios";

const NEW_LINE = "\n".charCodeAt(0);

// https://docs.discord.food/reference#client-properties
// Using android app's super props because it may be suspicious if we use web client's props and the version number never updates. On android it would be more plausible that someone doesn't auto update the app.
const superProps = {
    "os": "Android",
    "browser": "Discord Android",
    "device": "a20e", // Samsung Galaxy A20e
    "system_locale": "en-US",
    "has_client_mods": false,
    "client_version": "262.5 - rn",
    "release_channel": "alpha",
    "device_vendor_id": "17503929-a4b8-4490-87bf-0222adfdadc8",
    "design_id": 2,
    "browser_user_agent": "",
    "browser_version": "",
    "os_version": "34", // Android 14
    "client_build_number": 3463,
    "client_event_source": null
}

// Headers taken from Firefox HTTP request, some may be unnecessary
// I don't know which headers the Android app sends
const defaultHeaders = {
    "User-Agent": "Discord-Android/262205;RNA",
    "X-Super-Properties": btoa(JSON.stringify(superProps)),
    "X-Discord-Locale": "en-US",
    "X-Discord-Timezone": "Europe/Kyiv",

    // these I'm not sure about
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    // "X-Debug-Options": "bugReporterEnabled",
    "Alt-Used": "discord.com",
    // "Connection": "keep-alive",
    "Cookie": "locale=en-US",

    // these are likely unnecessary
    // "Referer": "https://discord.com/channels/.../...",
    // "Sec-Fetch-Dest": "empty",
    // "Sec-Fetch-Mode": "cors",
    // "Sec-Fetch-Site": "same-origin",
    // "Priority": "u=0",
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

                // Override os/browser info
                // Older j2me clients identify as Firefox on Linux instead, and new clients have "a" placeholders just because we can, and to save a bit of data
                if (parsed.d?.properties?.os) parsed.d.properties.os = "Android";
                if (parsed.d?.properties?.browser) parsed.d.properties.browser = "Discord Android";

                this.websocket?.send(JSON.stringify(parsed));
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