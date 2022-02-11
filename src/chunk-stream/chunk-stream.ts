import { BitstreamReader, BitstreamWriter } from "@astronautlabs/bitstream";
import * as net from 'net';
import * as crypto from 'crypto';
import { Observable, Subject } from "rxjs";
import { Bitstream } from "../util";
import { AbortMessageData, AcknowledgementData, ChunkHeader, ChunkHeader0, ChunkHeader1, ChunkHeader2, ChunkHeader3, Handshake0, Handshake1, Handshake2, Message, MessageData, SetChunkSizeData, SetPeerBandwidthData, WindowAcknowledgementSizeData } from "./syntax";
import { C1_RANDOM_SIZE, CONTROL_MESSAGE_STREAM_ID, MAX_TIMESTAMP, ProtocolMessageType, PROTOCOL_CHUNK_STREAM_ID } from "./constants";
import { AcknowledgedWritable } from "./acknowledged-writable";
import { AudioMessageData, VideoMessageData } from ".";

function zeroPad(number : string | number, digits = 2) {
    let str = `${number}`;
    while (str.length < digits)
        str = `0${str}`;
    return str;
}
export interface ChunkStreamState {
    timestamp? : number;
    timestampDelta? : number;
    messageLength? : number;
    messageTypeId? : number;
    messageStreamId? : number;
    messagePayload? : Buffer;
}

export type HandshakeState = 'uninitialized' | 'versionSent' | 'ackSent' | 'handshakeDone';

export class ChunkStreamWriter {
    constructor (private bitstream : Bitstream) {
    }

    maxChunkSize = 128;
    windowSize = 0;
    limitType = 1;
    messageStreamId : number;
    timestamp : number;
    messageLength : number;
    messageTypeId : number;
    pendingMessages = new Map<number, ChunkMessage[]>();
    streamStates = new Map<number, ChunkStreamState>();

    private getQueueForStream(id : number) {
        let pending = this.pendingMessages.get(id);
        if (!pending)
            this.pendingMessages.set(id, pending = []);
        return pending;
    }

    private getStateForStream(id : number): ChunkStreamState {
        let state = this.streamStates.get(id);
        if (!state)
            this.streamStates.set(id, state = {});
        return state;
    }

    private discardMessageFromQueue(streamId : number) {
        let queue = this.pendingMessages.get(streamId);
        if (!queue)
            return;

        queue.shift();

        if (queue.length === 0)
            this.pendingMessages.delete(streamId);
    }

    send(message : ChunkMessage) {
        message.bytesSent = 0;
        message.buffer = Buffer.from(message.data.serialize());

        let streamQueue = this.getQueueForStream(message.chunkStreamId);

        if (streamQueue.length === 0 && message.buffer.length < this.maxChunkSize) {

            // Send immediately without queuing
            new ChunkHeader0()
                .with({
                    chunkStreamId: message.chunkStreamId,
                    messageStreamId: message.messageStreamId,
                    messageTypeId: message.messageTypeId,
                    messageLength: message.buffer.length
                })
                .write(this.bitstream.writer)
            ;

            this.bitstream.writer.writeBytes(message.buffer);
            
            if (globalThis.RTMP_TRACE) {
                console.log(
                    `🔼 [${message.chunkStreamId}] 🚀 | ${message.data.inspect()} `
                    + `| msid=${message.messageStreamId}, type=${message.messageTypeId}, `
                        + `progress=${message.buffer.length}/${message.buffer.length}`
                );
            }

            return;
        } else {
            
            if (globalThis.RTMP_TRACE) {
                console.log(
                    `🔼 [${message.chunkStreamId}] ⌚ | ${message.data.inspect()} `
                    + `| msid=${message.messageStreamId}, type=${message.messageTypeId}, `
                        + `progress=${message.bytesSent}/${message.buffer.length}`
                );
            }

            streamQueue.push(message);
    
            clearTimeout(this.writeTimeout);
            this.writeTimeout = setTimeout(() => this.write());
        }
    }

    setChunkSize(chunkSize : number) {
        this.maxChunkSize = chunkSize;
        this.send({
            chunkStreamId: PROTOCOL_CHUNK_STREAM_ID,
            messageStreamId: CONTROL_MESSAGE_STREAM_ID,
            messageTypeId: ProtocolMessageType.SetChunkSize,
            timestamp: 0,
            data: new SetChunkSizeData().with({ chunkSize })
        })
    }

    abortMessage(chunkStreamId : number) {
        let queue = this.pendingMessages.get(chunkStreamId);
        if (!queue || queue.length === 0)
            return;
        queue.shift();

        this.send({
            chunkStreamId: PROTOCOL_CHUNK_STREAM_ID,
            messageStreamId: CONTROL_MESSAGE_STREAM_ID,
            messageTypeId: ProtocolMessageType.AbortMessage,
            timestamp: 0,
            data: new AbortMessageData()
                .with({ chunkStreamId })
        })
    }

    setAcknowledgementWindow(acknowledgementWindowSize : number) {
        this.send({
            chunkStreamId: PROTOCOL_CHUNK_STREAM_ID,
            messageStreamId: CONTROL_MESSAGE_STREAM_ID,
            messageTypeId: ProtocolMessageType.WindowAcknowledgementSize,
            timestamp: 0,
            data: new WindowAcknowledgementSizeData()
                .with({ acknowledgementWindowSize })
        });
    }

    setPeerBandwidth(acknowledgementWindowSize : number, limitType : 'hard' | 'soft' | 'dynamic') {
        this.send({
            chunkStreamId: PROTOCOL_CHUNK_STREAM_ID,
            messageStreamId: CONTROL_MESSAGE_STREAM_ID,
            messageTypeId: ProtocolMessageType.SetPeerBandwidth,
            timestamp: 0,
            data: new SetPeerBandwidthData()
                .with({ acknowledgementWindowSize, limitType: { hard: 0, soft: 1, dynamic: 2 }[limitType] })
        });
    }
    
    acknowledge(sequenceNumber : number) {
        this.send({
            chunkStreamId: PROTOCOL_CHUNK_STREAM_ID,
            messageStreamId: CONTROL_MESSAGE_STREAM_ID,
            messageTypeId: ProtocolMessageType.Acknowledgement,
            timestamp: 0,
            data: new AcknowledgementData()
                .with({ sequenceNumber })
        });
    }

    private write() {
        let remainingMessages = 0;

        for (let streamId of this.pendingMessages.keys()) {
            let queue = this.pendingMessages.get(streamId);
            let message = queue?.[0];

            if (!message) {
                this.discardMessageFromQueue(streamId);
                continue;
            }

            let state = this.getStateForStream(streamId);
            let header : ChunkHeader;

            if (!message.forceFullHeader && state.messageStreamId === message.messageStreamId) {
                let timestampDelta = message.timestamp - state.timestamp;

                if (state.messageLength === message.buffer.length && state.messageTypeId === message.messageTypeId) {
                    if (state.timestampDelta === timestampDelta) {
                        // Type 3
                        header = new ChunkHeader3().with({
                            chunkStreamId: streamId
                        })
                    } else {
                        // Type 2
                        header = new ChunkHeader2().with({
                            chunkStreamId: streamId,
                            timestamp: timestampDelta
                        });
                    }
                } else {
                    // Type 1
                    header = new ChunkHeader1().with({
                        chunkStreamId: streamId,
                        timestamp: timestampDelta,
                        messageLength: message.buffer.length,
                        messageTypeId: message.messageTypeId
                    });
                }

                state.timestampDelta = timestampDelta;
            } else {
                // Type 0

                header = new ChunkHeader0().with({
                    chunkStreamId: streamId,
                    timestamp: message.timestamp,
                    messageLength: message.buffer.length,
                    messageTypeId: message.messageTypeId,
                    messageStreamId: message.messageStreamId
                });

                // The semantics of timestamp delta after receiving Type 0 is unclear:
                // - Does the receiver compute the delta implicitly when receiving two consecutive Type-0's
                //   or does the last explicit timestamp delta used instead? 
                // Let's never send a Type 3 after Type 0 even if we could, so that the receiver doesn't
                // have to get the correct behavior in this case.

                state.timestampDelta = undefined;
            }

            header.write(this.bitstream.writer);

            let writeSize = Math.min(this.maxChunkSize, message.buffer.length - message.bytesSent);
            this.bitstream.writer.writeBytes(message.buffer.slice(message.bytesSent, message.bytesSent + writeSize));
            
            message.bytesSent += writeSize;

            state.messageStreamId = message.messageStreamId;
            state.messageLength = message.buffer.length;
            state.messageTypeId = message.messageTypeId;
            state.timestamp = message.timestamp;

            let remains = message.buffer.length - message.bytesSent;
            
            if (globalThis.RTMP_TRACE) {
                console.log(
                    `🔼 [${streamId}] ${remains <= 0 ? '✅' : '⬛'} | ${header.constructor.name.replace(/ChunkHeader/, 'Type')} ` 
                    + `| ${message.data.inspect()} `
                    + `| msid=${message.messageStreamId}, type=${message.messageTypeId}, `
                        + `progress=${message.bytesSent}/${message.buffer.length}`
                );
            }

            if (remains <= 0) {
                if (remains < 0) {
                    console.error(`RTMP: Bug: remains should be positive (${remains})`);
                }

                this.discardMessageFromQueue(streamId);
            }

            remainingMessages += queue.length;
        }

        if (remainingMessages > 0) {
            this.writeTimeout = setTimeout(() => this.write());
        }
    }

    private writeTimeout;
}

export class ChunkStreamSession {
    constructor(readonly bitstream : Bitstream) {
        this.reader = new ChunkStreamReader(this.bitstream);
        this.writer = new ChunkStreamWriter(this.bitstream);

        this.reader.acknowledgements.subscribe(sequenceNumber => this.writer.acknowledge(sequenceNumber));
        this.reader.messageReceived.subscribe(message => this.receiveMessage(message));
    }

    readonly reader : ChunkStreamReader;
    readonly writer : ChunkStreamWriter;

    #messageReceived = new Subject<Message>();
    get messageReceived() { return this.#messageReceived; }

    private receiveMessage(message : Message) {
        switch (message.typeId) {
            case ProtocolMessageType.SetPeerBandwidth: {
                let data = message.data as SetPeerBandwidthData;

                let windowSize : number;
                if (data.limitType === 0)
                    windowSize = data.acknowledgementWindowSize;
                else if (data.limitType === 1)
                    windowSize = Math.min(this.writer.windowSize, data.acknowledgementWindowSize);
                else if (data.limitType === 2 && this.writer.limitType === 0) {
                    windowSize = data.acknowledgementWindowSize;
                    data.limitType = 0;
                }
                
                this.writer.windowSize = windowSize;
                this.bitstream.writable.windowSize = windowSize;
                this.writer.limitType = data.limitType;
            } break;
            case ProtocolMessageType.Acknowledgement: {
                let data = message.data as AcknowledgementData;
                this.bitstream.writable.acknowledge(data.sequenceNumber);
            }
            default:
                this.#messageReceived.next(message);
        }
    }

    send(message : ChunkMessage) {
        this.writer.send(message);
    }

    setAcknowledgementWindow(acknowledgementWindowSize : number) {
        this.writer.setAcknowledgementWindow(acknowledgementWindowSize)
    }

    setPeerBandwidth(acknowledgementWindowSize : number, limitType : 'soft' | 'hard' | 'dynamic') {
        this.writer.setPeerBandwidth(acknowledgementWindowSize, limitType);
    }

    setChunkSize(chunkSize : number) {
        this.writer.setChunkSize(chunkSize);
    }

    static forSocket(socket : net.Socket) {
        let reader = new BitstreamReader();
        socket.on('data', data => reader.addBuffer(data));

        let writable = new AcknowledgedWritable(socket);

        return new ChunkStreamSession({ 
            reader, 
            writable,
            writer: new BitstreamWriter(writable)
        });
    }
}

export interface ChunkMessage {
    chunkStreamId : number;
    messageStreamId : number;
    messageTypeId : number;
    timestamp : number;
    data : MessageData,
    buffer? : Buffer;
    bytesSent? : number;
    forceFullHeader?: boolean;
}

export class ChunkStreamReader {
    constructor (
        private bitstream : Bitstream
    ) {
        this.start();
    }

    maxChunkSize = 128;
    chunkStreams = new Map<number, ChunkStreamState>();
    #messageReceived = new Subject<Message>();
    #controlMessageReceived = new Subject<Message>();
    #acknowledgements = new Subject<number>();

    sequenceNumber = 0;
    windowSize = 0;
    clientVersion : number;
    expectsExtendedTimestamp = false;

    get messageReceived(): Observable<Message> { return this.#messageReceived; }
    get controlMessageReceived(): Observable<Message> { return this.#controlMessageReceived; }
    get acknowledgements() { return <Observable<number>> this.#acknowledgements; }

    private async start() {
        await this.handshake();

        while (true) {
            let chunkHeader = await ChunkHeader.readBlocking(this.bitstream.reader, { params: [ this.expectsExtendedTimestamp ] });
            this.expectsExtendedTimestamp = chunkHeader.hasExtendedTimestamp;
            await this.receiveChunk(chunkHeader, this.bitstream.reader);

            if (this.windowSize > 0 && this.bitstream.reader.offset >= this.sequenceNumber + this.windowSize) {
                this.sequenceNumber += this.windowSize;
                this.#acknowledgements.next(this.sequenceNumber);
            }
        }
    }

    private async handshake() {
        if (globalThis.RTMP_TRACE === true) console.log(`RTMP: Handshake: Waiting for C0...`);
        this.clientVersion = (await Handshake0.readBlocking(this.bitstream.reader)).version;
        
        if (globalThis.RTMP_TRACE === true) console.log(`RTMP: Handshake: Sending S0...`);
        new Handshake0()
            .with({ version: 3 })
            .write(this.bitstream.writer);

        if (globalThis.RTMP_TRACE === true) console.log(`RTMP: Handshake: Waiting for C1...`);
        let c1 = await Handshake1.readBlocking(this.bitstream.reader);
        
        if (globalThis.RTMP_TRACE === true) console.log(`RTMP: Handshake: Sending S1...`);
        new Handshake1()
            .with({
                time: Math.floor(Date.now() / 1000),
                random: crypto.randomBytes(C1_RANDOM_SIZE)
            })
            .write(this.bitstream.writer)
        ;

        if (globalThis.RTMP_TRACE === true) console.log(`RTMP: Handshake: Sending S2...`);
        new Handshake2()
            .with({
                time: c1.time,
                time2: Math.floor(Date.now() / 1000),
                randomEcho: c1.random
            })
            .write(this.bitstream.writer);
        ;

        if (globalThis.RTMP_TRACE === true) console.log(`RTMP: Handshake: Waiting for C2...`);
        let c2 = await Handshake2.readBlocking(this.bitstream.reader);
        
        if (globalThis.RTMP_TRACE === true) console.log(`RTMP: Handshake: Done.`);
    }

    private getChunkStream(id : number) {
        let streamState = this.chunkStreams.get(id);
        if (!streamState) {
            this.chunkStreams.set(id, streamState = { 
                messagePayload: Buffer.alloc(0)
            });
        }
        return streamState;
    }

    private dispatchMessage(chunkStreamId : number, message : Message) {
        if (chunkStreamId === 2)
            this.handleControlMessage(message);
        else
            this.#messageReceived.next(message);
    }
    
    private handleControlMessage(message : Message) {
        switch (message.typeId) {
            case ProtocolMessageType.SetChunkSize: {
                this.maxChunkSize = Math.min(Math.max(1, (message.data as SetChunkSizeData).chunkSize), 16777215);
            } break;
            case ProtocolMessageType.AbortMessage: {
                this.getChunkStream((message.data as AbortMessageData).chunkStreamId).messagePayload = Buffer.alloc(0);
            } break;
            case ProtocolMessageType.Acknowledgement: {
                this.sequenceNumber = (message.data as AcknowledgementData).sequenceNumber;
            } break;
            case ProtocolMessageType.WindowAcknowledgementSize: {
                this.windowSize = (message.data as WindowAcknowledgementSizeData).acknowledgementWindowSize;
            } break;
            default:
                this.#messageReceived.next(message);
        }
    }

    private parseMessageData(messageTypeId : number, messageData : Buffer) {
        if (messageTypeId === ProtocolMessageType.Audio)
            return new AudioMessageData().with({ data: messageData });
        else if (messageTypeId === ProtocolMessageType.Video)
            return new VideoMessageData().with({ data: messageData });
        else
            return MessageData.deserialize(messageData, { params: [ messageTypeId, messageData.length ] });
    }

    private async receiveChunk(header : ChunkHeader, reader : BitstreamReader) {
        let state = this.getChunkStream(header.chunkStreamId);

        // Adopt any new state values from the headers for future use

        if (header instanceof ChunkHeader0)
            state.timestamp = header.timestamp;
        else if (typeof header.timestamp !== 'undefined')
            state.timestamp = (state.timestamp + header.timestamp) % MAX_TIMESTAMP;

        state.messageStreamId = header.messageStreamId ?? state.messageStreamId;
        state.messageLength = header.messageLength ?? state.messageLength;
        state.messageTypeId = header.messageTypeId ?? state.messageTypeId;

        // Fill in all header values based on our current state. This will have the 
        // effect of expanding a compressed header to a normal Type 0 (full) header
        // for any handlers downstream from here.

        header.timestamp = state.timestamp;
        header.messageStreamId = state.messageStreamId;
        header.messageLength = state.messageLength;
        header.messageTypeId = state.messageTypeId;

        let payloadSize = Math.min(state.messageLength - state.messagePayload.length, this.maxChunkSize);
        let payload = await reader.readBytesBlocking(Buffer.alloc(payloadSize));
        state.messagePayload = Buffer.concat([state.messagePayload, payload]);
        let done = state.messagePayload.length === state.messageLength;

        if (globalThis.RTMP_CHUNK_TRACE === true) {
            console.log(
                `🔽 [${header.chunkStreamId}] ${ done ? '◾' : '⬛'} `
                + `| ${header.constructor.name.replace(/ChunkHeader/, 'Type')} | msid=${header.messageStreamId}, type=${header.messageTypeId}, `
                    + `payload=${state.messagePayload.length}/${state.messageLength}`
            );
        }

        if (done) {
            let data : MessageData;

            try {
                data = this.parseMessageData(header.messageTypeId, state.messagePayload);
            } catch (e) {
                
                console.error(`RTMP: Failed to parse RTMP message: ${e.message}`);
                console.error(`- Header: ${JSON.stringify(header, undefined, 2)}`);
                console.log();
                console.error(`- Data:`);
                console.error(
                    Array.from(state.messagePayload)
                        .map(i => zeroPad(i.toString(2), 8))
                        .join(' ')
                );
                console.log();

                console.error(`- Bitstream Trace:`)
                console.log();

                globalThis.BITSTREAM_TRACE = true;
                try { this.parseMessageData(header.messageTypeId, state.messagePayload); } catch (e) {}
                globalThis.BITSTREAM_TRACE = false;

                console.log();
                console.error(`- Exception:`);
                console.error(e);
                console.log();

                throw e;
            }

            this.dispatchMessage(header.chunkStreamId, new Message().with({
                messageStreamId: state.messageStreamId,
                length: state.messageLength,
                timestamp: state.timestamp,
                typeId: header.messageTypeId,
                data
            }));
            state.messagePayload = Buffer.alloc(0);
        }
    }
}