import { BitstreamReader, BitstreamWriter } from "@astronautlabs/bitstream";
import { EventEmitter } from "stream";
import * as net from 'net';
import { ChunkStreamSession } from "./chunk-stream";
import { Handshake0, Handshake1, Handshake2 } from "./chunk-stream/syntax";
import { AcknowledgedWritable } from "./chunk-stream/acknowledged-writable";

export class Client {
    private socket : net.Socket;
    private connecting : Promise<void>;
    private resolveConnect;
    private rejectConnect;
    private connected = false;
    private reader : BitstreamReader;
    private writer : BitstreamWriter;
    private emitter = new EventEmitter();

    addEventListener(evtName : string, listener : any) {
        this.emitter.addListener(evtName, listener);
    }

    removeEventListener(evtName : string, listener : any) {
        this.emitter.removeListener(evtName, listener);
    }

    chunkSession : ChunkStreamSession;

    async connect(host : string, port = 1935) {
        if (this.connecting || this.connected)
            throw new Error(`Connection is already active`);
        
        this.connecting = new Promise<void>((resolve, reject) => 
            (this.resolveConnect = resolve, this.rejectConnect = reject)
        );
        this.connecting.finally(() => this.connecting = undefined);

        this.socket = net.createConnection({ host, port });
        this.reader = new BitstreamReader();

        let writable = new AcknowledgedWritable(this.socket);
        this.writer = new BitstreamWriter(writable);
        this.chunkSession = new ChunkStreamSession({ 
            reader: this.reader, 
            writable,
            writer: this.writer 
        });

        // TODO

        this.socket.addListener('connect', () => this.resolveConnect());
        this.socket.addListener('close', () => {
            this.rejectConnect(new Error(`Connection reset during setup`));
            this.emitter.emit('close');
        });
        this.socket.addListener('error', err => {
            this.rejectConnect(err);
            this.emitter.emit('error', err);
        });
        this.socket.addListener('data', data => this.reader.addBuffer(data));

        new Handshake0()
            .write(this.writer);
        new Handshake1()
            .with({ time: Date.now() })
            .write(this.writer);

        await this.reader.assure((1 + 1536)*8);

        let s0 = Handshake0.readSync(this.reader);
        let s1 = Handshake1.readSync(this.reader);

        new Handshake2()
            .with({ time: s1.time, time2: Date.now() })
            .write(this.writer);

        await this.reader.assure(1536*8);

        let s2 = Handshake2.readSync(this.reader);
    }
}
