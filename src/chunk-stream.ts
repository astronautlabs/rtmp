import { BitstreamElement, BitstreamReader, BitstreamWriter, DefaultVariant, Field, Variant, VariantMarker } from "@astronautlabs/bitstream";
import * as net from 'net';
import * as crypto from 'crypto';
import { Observable, Subject } from "rxjs";

export class ChunkMessage extends BitstreamElement {
    constructor(readonly init : Partial<ChunkMessage>) {
        super();
        Object.assign(this, init);
    }
    
    readonly typeId : number;
    readonly length : number;
    readonly timestamp : number;
    readonly messageStreamId : number;

    @Field() data : ChunkMessageData;

    static async forData(init : Partial<ChunkMessage>, data : Uint8Array) {
        let message = new ChunkMessage(init);
        let reader = new BitstreamReader();
        reader.addBuffer(data);

        let gen = new ChunkMessageData().read(reader);
        while (true) {
            let result = gen.next();
            if (result.done) {
                message.data = result.value;
                return message;
            }
            
            throw new Error(`While parsing ChunkMessage: Buffer exhausted with ${result.value} more bits expected`);
        }
    }
}

export interface ChunkStreamState {
    timestamp? : number;
    messageLength? : number;
    messageStreamId? : number;
}

export abstract class ChunkStreamId extends BitstreamElement {
    /**
     * This field identifies one of four format used by the ’chunk message header’. 
     * The ’chunk message header’ for each of the chunk types is explained in the next section.
     */
    @Field(6) csidPart1 : number;
    abstract chunkStreamId : number;
}

/**
 * One byte version of chunk stream ID (used to represent chunk stream Ids between 2 and 63)
 * https://rtmp.veriskope.com/docs/spec/#1-byte
 */
@Variant<ChunkStreamId>(i => 2 <= i.csidPart1 && i.csidPart1 <= 63)
export class ChunkStreamId1 extends ChunkStreamId {
    get chunkStreamId() { return this.csidPart1 };
}

/**
 * Two byte version of chunk stream ID (used to represent chunk stream IDs between 64 and 319)
 * https://rtmp.veriskope.com/docs/spec/#2-bytes
 */
@Variant<ChunkStreamId>(i => i.csidPart1 === 0)
export class ChunkStreamId2 extends ChunkStreamId {
    @Field(6) chunkStreamIdSub64 : number;
    get chunkStreamId() { return 64 + this.chunkStreamIdSub64; }
    set chunkStreamId(value) { this.chunkStreamIdSub64 = value; }
}

/**
 * Two byte version of chunk stream ID (used to represent chunk stream IDs between 64 and 65599)
 * https://rtmp.veriskope.com/docs/spec/#2-bytes
 */
@Variant<ChunkStreamId>(i => i.csidPart1 === 1)
export class ChunkStreamId3 extends ChunkStreamId {
    @Field(16) chunkStreamIdSub64 : number;
    get chunkStreamId() { return 64 + this.chunkStreamIdSub64; }
    set chunkStreamId(value) { this.chunkStreamIdSub64 = value; }
}

export class StreamChunk extends BitstreamElement {
    constructor(readonly streamState : ChunkStreamState) {
        super();
    }

    @Field() header : ChunkHeader;
    
}

@DefaultVariant()
export class StreamUnknownChunk extends StreamChunk {
    @Field((i : StreamUnknownChunk) => i.header?.messageLength ?? i.streamState.messageLength) data : Buffer;
}

export class ChunkHeader extends BitstreamElement {
    constructor(readonly streamState? : MultiplexedStreamState) {
        super();
    }

    /**
     * This field identifies one of four format used by the ’chunk message header’. 
     * The ’chunk message header’ for each of the chunk types is explained in the next section.
     */
    @Field(2) fmt : number;
    @Field() chunkStreamIdRep : ChunkStreamId;

    get chunkStreamId() {
        return this.chunkStreamIdRep?.chunkStreamId;
    }

    set chunkStreamId(value) {
        if (2 <= value && value <= 63)
            this.chunkStreamIdRep = new ChunkStreamId1().with({ chunkStreamId: value });
        else if (64 <= value && value <= 319)
            this.chunkStreamIdRep = new ChunkStreamId2().with({ chunkStreamId: value });
        else if (319 <= value && value <= 65599)
            this.chunkStreamIdRep = new ChunkStreamId3().with({ chunkStreamId: value });
        else
            throw new TypeError(`Cannot set chunk stream ID to a value greater than 65599 (max chunk stream ID)`);
    }
    
    basicTimestamp : number;
    messageLength : number;
    messageTypeId : number;
    messageStreamId : number;

    @VariantMarker() $variant;

    @Field(8*4, { presentWhen: (i : ChunkHeader) => typeof i.basicTimestamp !== 'undefined' ? i.hasExtendedTimestamp : i.streamState.hasExtendedTimestamp })
    extendedTimestamp : number;

    get hasExtendedTimestamp() {
        return this.basicTimestamp === 0xFFFFFF;
    }

    get timestamp() {
        if (this.hasExtendedTimestamp)
            return this.extendedTimestamp;
        else
            return this.basicTimestamp;
    }

    set timestamp(value) {
        if (value >= 0xFFFFFF) {
            this.basicTimestamp = 0xFFFFFF;
            this.extendedTimestamp = value;
        } else {
            this.basicTimestamp = value;
        }
    }
}

@Variant<ChunkHeader>(i => i.fmt === 0)
export class ChunkHeader0 extends ChunkHeader {
    @Field(8*3) basicTimestamp : number;
    @Field(8*3) messageLength : number;
    @Field(8*1) messageTypeId : number;
    @Field(8*4) messageStreamId : number;
}

@Variant<ChunkHeader>(i => i.fmt === 1)
export class ChunkHeader1 extends ChunkHeader {
    @Field(8*3) basicTimestamp : number;
    @Field(8*3) messageLength : number;
    @Field(8*1) messageTypeId : number;
    messageStreamId : undefined;
}

@Variant<ChunkHeader>(i => i.fmt === 2)
export class ChunkHeader2 extends ChunkHeader {
    @Field(8*3) basicTimestamp : number;
    messageLength : undefined;
    messageTypeId : undefined;
    messageStreamId : undefined;
}

@Variant<ChunkHeader>(i => i.fmt === 3)
export class ChunkHeader3 extends ChunkHeader {
    basicTimestamp : undefined;
    messageLength : undefined;
    messageTypeId : undefined;
    messageStreamId : undefined;
}

export class Handshake0 extends BitstreamElement {
    /**
     * In C0, this field identifies the RTMP version requested by the client. In S0, this field identifies the RTMP 
     * version selected by the server. The version defined by this specification is 3. Values 0-2 are deprecated values 
     * used by earlier proprietary products; 4-31 are reserved for future implementations; and 32-255 are not allowed 
     * (to allow distinguishing RTMP from text-based protocols, which always start with a printable character). A 
     * server that does not recognize the client’s requested version SHOULD respond with 3. The client MAY choose to 
     * degrade to version 3, or to abandon the handshake.
     */
    @Field(8*1) version : number;
}

export const C1_SIZE = 1536;
export const C1_RANDOM_SIZE = 1528;

export class Handshake1 extends BitstreamElement {
    /**
     * This field contains a timestamp, which SHOULD be used as the epoch for all future chunks sent from this 
     * endpoint. This may be 0, or some arbitrary value. To synchronize multiple chunkstreams, the endpoint may wish 
     * to send the current value of the other chunkstream’s timestamp.
     */
    @Field(8*4) time : number;

    /**
     *  This field MUST be all 0s.
     */
    @Field(8*4, { writtenValue: () => 0 }) zero : number = 0;

    /**
     * This field can contain any arbitrary values. Since each endpoint has to distinguish between the response to the 
     * handshake it has initiated and the handshake initiated by its peer,this data SHOULD send something sufficiently 
     * random. But there is no need for cryptographically-secure randomness, or even dynamic values
     */
    @Field(1*C1_RANDOM_SIZE) random : Buffer;
}

export class Handshake2 extends BitstreamElement {
    /**
     * This field MUST contain the timestamp sent by the peer in S1 (for C2) or C1 (for S2).
     */
    @Field(8*4) time : number;

    /**
     * This field MUST contain the timestamp at which the previous packet(s1 or c1) sent by the peer was read.
     */
    @Field(8*4) time2 : number;

    /**
     * This field MUST contain the random data field sent by the peer in S1 (for C2) or S2 (for C1). Either peer can 
     * use the time and time2 fields together with the current timestamp as a quick estimate of the bandwidth and/or 
     * latency of the connection, but this is unlikely to be useful.
     */
    @Field(1*1528) randomEcho : Buffer;
}

export type HandshakeState = 'uninitialized' | 'versionSent' | 'ackSent' | 'handshakeDone';

export class ChunkMessageData extends BitstreamElement {
    get message() { return this.parent as ChunkMessage; }
}

@Variant<ChunkMessageData>(i => i.message.typeId === 1)
export class SetChunkSizeData extends ChunkMessageData {
    @Field(1) zero : number;
    @Field(31) chunkSize : number;
}

@Variant<ChunkMessageData>(i => i.message.typeId === 2)
export class AbortMessageData extends ChunkMessageData {
    @Field(32) chunkStreamId : number;
}

@Variant<ChunkMessageData>(i => i.message.typeId === 3)
export class AcknowledgementData extends ChunkMessageData {
    sequenceNumber : number;
}

@Variant<ChunkMessageData>(i => i.message.typeId === 4)
export class EventData extends ChunkMessageData {
    @Field(8*2) eventType : number;
}

@Variant<EventData>(i => i.eventType === 0)
export class StreamBeginEventData extends ChunkMessageData {
    @Field(4) streamID : number;
}

@Variant<EventData>(i => i.eventType === 1)
export class StreamEndEventData extends ChunkMessageData {
    @Field(4) streamID : number;
}

@Variant<EventData>(i => i.eventType === 2)
export class StreamDryEventData extends ChunkMessageData {
    @Field(4) streamID : number;
}

@Variant<EventData>(i => i.eventType === 3)
export class SetBufferLengthEventData extends ChunkMessageData {
    @Field(4) streamID : number;
    @Field(4) bufferLength : number;
}

@Variant<EventData>(i => i.eventType === 4)
export class StreamIsRecordedEventData extends ChunkMessageData {
    @Field(4) streamID : number;
}

@Variant<EventData>(i => i.eventType === 6)
export class PingRequestData extends ChunkMessageData {
    @Field(4) timestamp: number;
}

@Variant<EventData>(i => i.eventType === 7)
export class PingResponseData extends ChunkMessageData {
    @Field(4) timestamp: number;
}

@Variant<ChunkMessageData>(i => i.message.typeId === 5)
export class WindowAcknowledgementSizeData extends ChunkMessageData {
    @Field(8*4) acknowledgementWindowSize : number;
}

@Variant<ChunkMessageData>(i => i.message.typeId === 6)
export class SetPeerBandwidthData extends ChunkMessageData {
    @Field(8*4) acknowledgementWindowSize : number;
    @Field(8*1) limitType : number;
}

@DefaultVariant()
export class RTMPMessageData extends ChunkMessageData {
    @Field(8*1) messageType : number;
    @Field(8*3) length : number;
    @Field(8*4) timestamp : number;
    @Field(8*3) messageStreamId : number;
    
    @VariantMarker()
    $marker;
}

@DefaultVariant()
export class UnknownRTMPMessageData extends RTMPMessageData {
    @Field((i : RTMPMessageData) => i.length)
    data : Buffer;
}

export class ChunkPayload extends BitstreamElement {
    readonly size : number;

    @Field((i : ChunkPayload) => i.size) bytes : Buffer;

    static withSize(size : number) {
        return <typeof ChunkPayload> class extends ChunkPayload {
            size = size
        };
    }
}

const MAX_TIMESTAMP = 2**32;

export class ChunkStreamWriter {
    constructor (
        public maxChunkSize : number, 
        readonly id : number
    ) {
    }

    messageStreamId : number;
    timestamp : number;
    messageLength : number;
    messageTypeId : number;
    
    writeMessage(message : ChunkMessage) {

    }
}

export class ChunkStreamReader {
    constructor (
        readonly id : number,
        public maxChunkSize : number
    ) {
    }

    messageStreamId : number;
    timestamp : number;
    messageLength : number;
    messageTypeId : number;
    messagePayload = Buffer.alloc(0);
    #messageReceived = new Subject<ChunkMessage>();
    hasExtendedTimestamp = false;

    get messageReceived(): Observable<ChunkMessage> { return this.messageReceived; }

    abortMessage() {
        // TODO
        throw new Error(`Not implemented yet`);
    }

    async receiveChunk(header : ChunkHeader, reader : BitstreamReader) {
        if (header.messageLength !== undefined)
            this.messageLength = header.messageLength;

        // Adopt any new state values from the headers for future use

        if (header instanceof ChunkHeader0)
            this.timestamp = header.timestamp;
        else if (typeof header.timestamp !== 'undefined')
            this.timestamp = (this.timestamp + header.timestamp) % MAX_TIMESTAMP;

        if (typeof header.messageStreamId !== 'undefined')
            this.messageStreamId = header.messageStreamId;

        if (typeof header.messageLength !== 'undefined')
            this.messageLength = header.messageLength;

        if (typeof header.messageTypeId !== 'undefined')
            this.messageTypeId = header.messageTypeId;

        if (header.timestamp)

        // Fill in all header values based on our current state. This will have the 
        // effect of expanding a compressed header to a normal Type 0 (full) header
        // for any handlers downstream from here.

        header.timestamp = this.timestamp;
        header.chunkStreamId = this.id;
        header.messageStreamId = this.messageStreamId;
        header.messageLength = this.messageLength;
        header.messageTypeId = this.messageTypeId;

        let payloadSize = Math.min(this.messageLength - this.messagePayload.length, this.maxChunkSize);
        let payload = await ChunkPayload.withSize(payloadSize).readBlocking(reader);
        this.messagePayload = Buffer.concat([this.messagePayload, payload.bytes]);
        if (this.messagePayload.length === this.messageLength) {
            // message ready for dispatch

            let message = await ChunkMessage.forData({
                messageStreamId: this.id,
                length: this.messageLength,
                timestamp: this.timestamp,
                typeId: this.messageTypeId ?? header.messageTypeId
            }, this.messagePayload);

            this.#messageReceived.next(message);
            this.messagePayload = Buffer.alloc(0);
        }
    }
}

export interface MultiplexedStreamState {
    maxChunkSize : number;
    windowSize : number;
    limitType : number;
    sequenceNumber : number;
    hasExtendedTimestamp : boolean;
}

export class Session {
    constructor(
        readonly socket : net.Socket,
        readonly server : Server
    ) {
        this.server.connections.push(this);
        this.reader = new BitstreamReader();
        this.writer = new BitstreamWriter(socket);
        this.socket.on('data', data => this.reader.addBuffer(data));
        this.socket.on('close', () => this.server.connections = this.server.connections.filter(x => x !== this));
        this.handle();
    }

    maxChunkSize = 128;
    reader : BitstreamReader;
    writer : BitstreamWriter;
    handshakeState : HandshakeState;
    clientVersion : number;
    chunkStreamMap = new Map<number, ChunkStreamReader>();

    readState : MultiplexedStreamState = {
        maxChunkSize: this.maxChunkSize,
        windowSize: 0,
        limitType: 1,
        sequenceNumber: 0,
        hasExtendedTimestamp: false
    };

    writeState : MultiplexedStreamState = {
        maxChunkSize: this.maxChunkSize,
        windowSize: 0,
        limitType: 1,
        sequenceNumber: 0,
        hasExtendedTimestamp: false
    };

    get chunkStreams() {
        return Array.from(this.chunkStreamMap.values());
    }

    private handleProtocolMessage(message : ChunkMessage) {
        if (message.messageStreamId !== 0)
            return;
        
        switch (message.typeId) {
            case 1: {
                this.maxChunkSize = Math.min(Math.max(1, (message.data as SetChunkSizeData).chunkSize), 16777215);
                this.chunkStreams.forEach(s => s.maxChunkSize = this.maxChunkSize);
            } break;
            case 2: {
                this.getChunkStream((message.data as AbortMessageData).chunkStreamId).abortMessage();
            } break;
            case 3: {
                this.readState.sequenceNumber = (message.data as AcknowledgementData).sequenceNumber;
            } break;
            case 4: {
                let eventData = message.data as EventData;
                switch (eventData.eventType) {
                    // TODO
                    default:
                        // TODO
                }
            }
            case 5: {
                this.readState.windowSize = (message.data as WindowAcknowledgementSizeData).acknowledgementWindowSize;
            } break;
            case 6: {
                let data = message.data as SetPeerBandwidthData;

                if (data.limitType === 0)
                    this.writeState.windowSize = data.acknowledgementWindowSize;
                else if (data.limitType === 1)
                    this.writeState.windowSize = Math.min(this.writeState.windowSize, data.acknowledgementWindowSize);
                else if (data.limitType === 2 && this.writeState.limitType === 0) {
                    this.writeState.windowSize = data.acknowledgementWindowSize;
                    data.limitType = 0;
                }
                
                this.writeState.limitType = data.limitType;
            } break;
        }
    }

    private async handle() {
        await this.handshake();

        this.getChunkStream(2).messageReceived.subscribe(message => this.handleProtocolMessage(message));

        let chunkStreamId : number = undefined;

        while (true) {
            let chunkHeader = await ChunkHeader.readBlocking(this.reader, undefined, undefined, [ this.readState ]);

            if (chunkHeader.chunkStreamId !== undefined)
                chunkStreamId = chunkHeader.chunkStreamId;
            
            let chunkStream = this.getChunkStream(chunkStreamId);
            await chunkStream.receiveChunk(chunkHeader, this.reader);

            if (this.reader.offset >= this.readState.sequenceNumber + this.readState.windowSize) {
                this.readState.sequenceNumber += this.readState.windowSize;
                let payload = new AcknowledgementData()
                    .with({ sequenceNumber: this.readState.sequenceNumber })
                    .serialize()
                ;

                // sending the whole thing no matter what because we aren't monsters

                new ChunkHeader0()
                    .with({
                        chunkStreamId: 2,
                        messageStreamId: 0,
                        messageLength: payload.length
                    })
                    .write(this.writer)
                ;
                this.writer.writeBuffer(payload);
            }
        }
    }

    getChunkStream(chunkStreamId : number) {
        if (!this.chunkStreamMap.has(chunkStreamId))
            this.chunkStreamMap.set(chunkStreamId, new ChunkStreamReader(chunkStreamId, this.maxChunkSize));

        return this.chunkStreamMap.get(chunkStreamId);
    }

    private async handshake() {
        this.clientVersion = (await Handshake0.readBlocking(this.reader)).version;
        new Handshake0()
            .with({ version: this.server.version })
            .write(this.writer);

        let c1 = await Handshake1.readBlocking(this.reader);
        new Handshake1()
            .with({
                time: Math.floor(Date.now() / 1000),
                random: crypto.randomBytes(C1_RANDOM_SIZE)
            })
            .write(this.writer)
        ;

        let c2 = await Handshake2.readBlocking(this.reader);
        new Handshake2()
            .with({
                time: c1.time,
                time2: Math.floor(Date.now() / 1000),
                randomEcho: c1.random
            })
            .write(this.writer);
        ;
    }
}

export class Server {
    constructor(readonly port = 1935) {

    }

    public version = 3;
    private _server : net.Server;
    public connections : Session[] = [];

    async listen() {
        this._server = new net.Server(socket => new Session(socket, this));
        this._server.listen(this.port);
    }
}