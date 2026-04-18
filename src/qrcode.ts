import { Socket } from "net";
import WebSocket from 'ws';
import axios from 'axios';
import { defaultHeaders } from "./Client";

export default class QRLoginServer {
    // Reference:
    // https://discord.neko.wtf/remote_auth/
    // https://github.com/malmeloo/Discord-QR-Auth-Client/blob/master/server.py

    private clientSocket: Socket;
    private socket: WebSocket;
    private keyPair: any;
    private disconnectTimeout: NodeJS.Timeout;
    private heartbeatInterval: NodeJS.Timeout;

    constructor(clientSocket) {
        this.clientSocket = clientSocket;
        
        this.socket = new WebSocket(
            "wss://remote-auth-gateway.discord.gg/?v=2",
            {origin: "https://discord.com"}
        );

        this.socket.on("open", (event) => {
            // console.log("Remote auth gateway connected.");
        });

        this.socket.on("message", async (event: Buffer) => {
            const msg = JSON.parse(event.toString());

            // console.log("Remote auth gateway sent: ", msg);

            switch (msg.op) {
                case "hello": {
                    this.keyPair = await crypto.subtle.generateKey(
                        {
                            name: "RSA-OAEP",
                            modulusLength: 2048,
                            publicExponent: new Uint8Array([1, 0, 1]),
                            hash: "SHA-256",
                        },
                        true,
                        ["encrypt", "decrypt"],
                    );

                    const pubKey = await crypto.subtle.exportKey("spki", this.keyPair.publicKey);
                    const pubKeyB64 = Buffer.from(pubKey).toString('base64');

                    this.heartbeatInterval = setInterval(() => {
                        this.send({op: "heartbeat"});
                    }, msg.heartbeat_interval);

                    this.disconnectTimeout = setTimeout(() => {
                        // console.log("Remote auth gateway timed out.");

                        this.close(4003, "Handshake Timeout");
                    }, msg.timeout_ms);

                    this.send({
                        op: "init",
                        encoded_public_key: pubKeyB64
                    });
                    break;
                }

                case "nonce_proof": {
                    // note: base64url used here for encoding, while normal base64 used elsewhere
                    const nonce = await this.decryptBase64(msg.encrypted_nonce, "base64url");

                    this.send({
                        op: "nonce_proof",
                        nonce
                    });
                    break;
                }

                case "pending_remote_init": {
                    // console.log(`Remote auth gateway sent pending remote init: '${msg.fingerprint}'`);

                    this.sendToClient({
                        t: "qrlogin_code",
                        d: msg.fingerprint  //`https://discord.com/ra/${msg.fingerprint}`
                    })
                    break;
                }

                case "pending_ticket": {
                    const userInfo = await this.decryptBase64(msg.encrypted_user_payload);

                    // console.log(`Remote auth gateway sent pending login for '${userInfo}'`);
                    break;
                }

                case "pending_login": {
                    const response = await axios.post(
                        "https://discord.com/api/v9/users/@me/remote-auth/login",
                        {ticket: msg.ticket},
                        {headers: defaultHeaders}
                    );
                    
                    const token = await this.decryptBase64(response.data.encrypted_token);

                    // console.log(`Got token '${token}'`);

                    this.sendToClient({
                        t: "qrlogin_token",
                        d: token
                    })
                    this.close();
                    break;
                }

                case "cancel": {
                    this.close();
                    break;
                }
                
                case "heartbeat_ack": {
                    break;
                }

                default: {
                    // console.log(`Remote auth gateway sent unknown opcode: '${msg.op}'`);
                    break;
                }
            }
        });

        this.socket.on("error", (event) => {
            console.log("Error occurred with remote auth gateway connection.");
            console.log(event);
        });

        this.socket.on("close", (event: any) => {
            // console.log("Remote auth gateway disconnected.");
            // console.log(`code ${event.code}, reason '${event.reason}'`);

            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
            }
            if (this.disconnectTimeout) {
                clearTimeout(this.disconnectTimeout);
            }
            this.sendToClient({t: "qrlogin_disconnect"});
        });
    }

    async decryptBase64(data: string, outputEncoding?: BufferEncoding) {
        const buf: Buffer = Buffer.from(data, "base64");

        const arr = new Uint8Array(buf).buffer;

        const decrypted = await crypto.subtle.decrypt(
            {name: "RSA-OAEP"},
            this.keyPair.privateKey,
            arr
        );
        return Buffer.from(decrypted).toString(outputEncoding);
    }

    send(obj) {
        this.socket.send(JSON.stringify(obj));
    }

    sendToClient(obj) {
        // this.clientSocket.send(JSON.stringify(obj));  // for websocket client
        this.clientSocket.write(JSON.stringify(obj) + "\n");  // for tcp client
    }

    close(code?, data?) {
        this.socket.close(code, data);
    }
}

// module.exports = QRLoginServer;