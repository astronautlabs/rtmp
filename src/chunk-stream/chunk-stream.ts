import { BitstreamReader, BitstreamWriter } from "@astronautlabs/bitstream";
import * as net from 'net';
import * as crypto from 'crypto';
import { Observable, Subject } from "rxjs";
import { Bitstream } from "../util";
import { AbortMessageData, AcknowledgementData, ChunkHeader, ChunkHeader0, ChunkHeader1, ChunkHeader2, ChunkHeader3, Handshake0, Handshake1, Handshake2, Message, MessageData, SetChunkSizeData, SetPeerBandwidthData, WindowAcknowledgementSizeData } from "./syntax";
import { C1_RANDOM_SIZE, CONTROL_MESSAGE_STREAM_ID, MAX_TIMESTAMP, ProtocolMessageType, PROTOCOL_CHUNK_STREAM_ID } from "./constants";

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
            this.streamStates.set(id, {});
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
        let streamQueue = this.getQueueForStream(message.chunkStreamId);
        streamQueue.push(message);

        clearTimeout(this.writeTimeout);
        this.writeTimeout = setTimeout(() => this.write());

        if (message.buffer.length < this.maxChunkSize) {
            // Send immediately without queuing
            new ChunkHeader0().with({
                chunkStreamId: message.chunkStreamId,
                messageStreamId: message.messageStreamId,
                messageTypeId: message.messageTypeId,
                messageLength: message.buffer.length
            }).write(this.bitstream.writer);
            this.bitstream.writer.writeBuffer(message.buffer);
            return;
        }
    }

    setChunkSize(chunkSize : number) {
        this.maxChunkSize = chunkSize;
        this.send({
            chunkStreamId: PROTOCOL_CHUNK_STREAM_ID,
            messageStreamId: CONTROL_MESSAGE_STREAM_ID,
            messageTypeId: ProtocolMessageType.SetChunkSize,
            timestamp: 0,
            buffer: Buffer.from(
                new SetChunkSizeData()
                .with({ chunkSize })
                .serialize()
            )
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
            buffer: Buffer.from(
                new AbortMessageData()
                    .with({ chunkStreamId })
                    .serialize()
            )
        })
    }

    setAcknowledgementWindow(acknowledgementWindowSize : number) {
        this.send({
            chunkStreamId: PROTOCOL_CHUNK_STREAM_ID,
            messageStreamId: CONTROL_MESSAGE_STREAM_ID,
            messageTypeId: ProtocolMessageType.WindowAcknowledgementSize,
            timestamp: 0,
            buffer: Buffer.from(
                new WindowAcknowledgementSizeData()
                    .with({ acknowledgementWindowSize })
                    .serialize()
            )
        });
    }

    setPeerBandwidth(acknowledgementWindowSize : number, limitType : 'hard' | 'soft' | 'dynamic') {
        this.send({
            chunkStreamId: PROTOCOL_CHUNK_STREAM_ID,
            messageStreamId: CONTROL_MESSAGE_STREAM_ID,
            messageTypeId: ProtocolMessageType.SetPeerBandwidth,
            timestamp: 0,
            buffer: Buffer.from(
                new SetPeerBandwidthData()
                    .with({ acknowledgementWindowSize, limitType: { hard: 0, soft: 1, dynamic: 2 }[limitType] })
                    .serialize()
            )
        });
    }
    
    acknowledge(sequenceNumber : number) {
        this.send({
            chunkStreamId: PROTOCOL_CHUNK_STREAM_ID,
            messageStreamId: CONTROL_MESSAGE_STREAM_ID,
            messageTypeId: ProtocolMessageType.Acknowledgement,
            timestamp: 0,
            buffer: Buffer.from(
                new AcknowledgementData()
                .with({ sequenceNumber })
                .serialize()
            )
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

            if (!message.forceFullHeader && state.messageStreamId === message.messageStreamId) {
                let timestampDelta = message.timestamp - state.timestamp;

                if (state.messageLength === message.buffer.length && state.messageTypeId === message.messageTypeId) {
                    if (state.timestampDelta === timestampDelta) {
                        // Type 3
                        new ChunkHeader3()
                            .write(this.bitstream.writer);
                    } else {
                        // Type 2
                        new ChunkHeader2()
                            .with({
                                timestamp: timestampDelta
                            })
                            .write(this.bitstream.writer);
                    }
                } else {
                    // Type 1
                    new ChunkHeader1()
                        .with({
                            timestamp: timestampDelta,
                            messageLength: message.buffer.length,
                            messageTypeId: message.messageTypeId
                        })
                        .write(this.bitstream.writer);
                }

                state.timestampDelta = timestampDelta;
            } else {
                // Type 0

                new ChunkHeader0()
                    .with({
                        timestamp: message.timestamp,
                        messageLength: message.buffer.length,
                        messageTypeId: message.messageTypeId,
                        messageStreamId: message.messageStreamId
                    })
                    .write(this.bitstream.writer);

                // The semantics of timestamp delta after receiving Type 0 is unclear:
                // - Does the receiver compute the delta implicitly when receiving two consecutive Type-0's
                //   or does the last explicit timestamp delta used instead? 
                // Let's never send a Type 3 after Type 0 even if we could, so that the receiver doesn't
                // have to get the correct behavior in this case.

                state.timestampDelta = undefined;
            }
            
            let writeSize = Math.min(this.maxChunkSize, message.buffer.length - message.bytesSent);
            this.bitstream.writer.writeBuffer(message.buffer.slice(message.bytesSent, message.bytesSent + writeSize));
            message.bytesSent += writeSize;

            state.messageStreamId = message.messageStreamId;
            state.messageLength = message.buffer.length;
            state.messageTypeId = message.messageTypeId;
            state.timestamp = message.timestamp;

            let remains = message.buffer.length - message.bytesSent;
            if (remains <= 0) {
                if (remains < 0) {
                    console.error(`bug: remains should be positive (${remains})`);
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

                if (data.limitType === 0)
                    this.writer.windowSize = data.acknowledgementWindowSize;
                else if (data.limitType === 1)
                    this.writer.windowSize = Math.min(this.writer.windowSize, data.acknowledgementWindowSize);
                else if (data.limitType === 2 && this.writer.limitType === 0) {
                    this.writer.windowSize = data.acknowledgementWindowSize;
                    data.limitType = 0;
                }
                
                this.writer.limitType = data.limitType;
            } break;
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
        return new ChunkStreamSession({ reader, writer: new BitstreamWriter(socket) });
    }
}

export interface ChunkMessage {
    chunkStreamId : number;
    messageStreamId : number;
    messageTypeId : number;
    timestamp : number;
    buffer : Buffer;
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
            this.receiveChunk(chunkHeader, this.bitstream.reader);

            if (this.bitstream.reader.offset >= this.sequenceNumber + this.windowSize) {
                this.sequenceNumber += this.windowSize;
                this.#acknowledgements.next(this.sequenceNumber);
            }
        }
    }

    private async handshake() {
        this.clientVersion = (await Handshake0.readBlocking(this.bitstream.reader)).version;
        new Handshake0()
            .with({ version: 3 })
            .write(this.bitstream.writer);

        let c1 = await Handshake1.readBlocking(this.bitstream.reader);
        new Handshake1()
            .with({
                time: Math.floor(Date.now() / 1000),
                random: crypto.randomBytes(C1_RANDOM_SIZE)
            })
            .write(this.bitstream.writer)
        ;

        let c2 = await Handshake2.readBlocking(this.bitstream.reader);
        new Handshake2()
            .with({
                time: c1.time,
                time2: Math.floor(Date.now() / 1000),
                randomEcho: c1.random
            })
            .write(this.bitstream.writer);
        ;
    }

    private getChunkStream(id : number) {
        let streamState = this.chunkStreams.get(id);
        if (!streamState)
            this.chunkStreams.set(id, streamState = {});
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

        if (state.messagePayload.length === state.messageLength) {
            this.dispatchMessage(header.chunkStreamId, new Message().with({
                messageStreamId: state.messageStreamId,
                length: state.messageLength,
                timestamp: state.timestamp,
                typeId: state.messageTypeId ?? header.messageTypeId,
                data: MessageData.deserialize(state.messagePayload)
            }));
            state.messagePayload = Buffer.alloc(0);
        }
    }
}